use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::filter::{Filter, FilterConfig};
use crate::model::*;
use crate::path;
use crate::pcloud::{self, ApiError};
use crate::planner;
use crate::remote_tree::RemoteTree;

const SNAPSHOT_VERSION: u32 = 1;

/// Sync state of one vault on one device. Baseline changes come back as journal
/// lines; the remote tree and cursor are a cache and only go into snapshots.
pub struct Engine {
    device_id: String,
    seq: u64,
    cursor: Option<u64>,
    tree: Option<RemoteTree>,
    base: Baseline,
    /// Remote folder the baseline belongs to. Kept even while the tree is gone.
    paired_root: Option<u64>,
    /// Folders diff told us to list; planning waits until they are.
    pending_list: BTreeSet<u64>,
    filter_config: FilterConfig,
    filter: Filter,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    device_id: String,
    seq: u64,
    cursor: Option<u64>,
    tree: Option<RemoteTree>,
    base: Vec<BaseEntry>,
    #[serde(default)]
    paired_root: Option<u64>,
    #[serde(default)]
    pending_list: BTreeSet<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum JournalOp {
    Put { entry: BaseEntry },
    Remove { path: String },
    Pair { root: u64 },
}

#[derive(Serialize, Deserialize)]
struct JournalLine {
    seq: u64,
    #[serde(flatten)]
    op: JournalOp,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    /// State copied over from another device, e.g. with the whole vault.
    OtherDevice,
    Unsupported(u32),
    Corrupt(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::OtherDevice => write!(f, "sync state belongs to another device"),
            LoadError::Unsupported(v) => write!(f, "unsupported state version {v}"),
            LoadError::Corrupt(e) => write!(f, "sync state is damaged: {e}"),
        }
    }
}

impl std::error::Error for LoadError {}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DiffOutcome {
    pub reset: bool,
    pub list_folders: Vec<u64>,
    /// No more pages right now.
    pub caught_up: bool,
}

impl Engine {
    pub fn new(device_id: &str) -> Self {
        let filter_config = FilterConfig::default();
        Engine {
            device_id: device_id.to_string(),
            seq: 0,
            cursor: None,
            tree: None,
            base: Baseline::new(),
            paired_root: None,
            pending_list: BTreeSet::new(),
            filter: Filter::new(&filter_config),
            filter_config,
        }
    }

    pub fn load(
        device_id: &str,
        snapshot: Option<&str>,
        journal: Option<&str>,
    ) -> Result<Self, LoadError> {
        let mut engine = Engine::new(device_id);
        if let Some(text) = snapshot.filter(|s| !s.trim().is_empty()) {
            let snap: Snapshot =
                serde_json::from_str(text).map_err(|e| LoadError::Corrupt(e.to_string()))?;
            if snap.version != SNAPSHOT_VERSION {
                return Err(LoadError::Unsupported(snap.version));
            }
            if snap.device_id != device_id {
                return Err(LoadError::OtherDevice);
            }
            engine.seq = snap.seq;
            engine.cursor = snap.cursor;
            engine.paired_root = snap
                .paired_root
                .or(snap.tree.as_ref().map(RemoteTree::root));
            engine.pending_list = snap.pending_list;
            engine.tree = snap.tree;
            engine.base = snap
                .base
                .into_iter()
                .map(|e| (path::key(&e.path), e))
                .collect();
        }
        for line in journal.unwrap_or_default().lines() {
            if line.trim().is_empty() {
                continue;
            }
            // A torn line means the app died mid-write; that commit never happened.
            let Ok(entry) = serde_json::from_str::<JournalLine>(line) else {
                continue;
            };
            if entry.seq <= engine.seq {
                continue;
            }
            engine.seq = entry.seq;
            engine.apply_op(entry.op);
        }
        Ok(engine)
    }

    pub fn snapshot(&self) -> String {
        serde_json::to_string(&Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: self.device_id.clone(),
            seq: self.seq,
            cursor: self.cursor,
            tree: self.tree.clone(),
            base: self.base.values().cloned().collect(),
            paired_root: self.paired_root,
            pending_list: self.pending_list.clone(),
        })
        .expect("snapshot serializes")
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn set_filter(&mut self, config: FilterConfig) {
        self.filter = Filter::new(&config);
        self.filter_config = config;
    }

    pub fn filter_config(&self) -> &FilterConfig {
        &self.filter_config
    }

    pub fn has_remote(&self) -> bool {
        self.tree.is_some()
    }

    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }

    pub fn base_len(&self) -> usize {
        self.base.len()
    }

    /// Fresh recursive listing of the vault folder. A baseline made against any
    /// other folder (or against an unknown one) is dropped: it describes another pairing.
    pub fn reset_remote(&mut self, listing: &str, cursor: u64) -> Result<Vec<String>, ApiError> {
        let meta = pcloud::parse_metadata(listing)?;
        let mut journal = Vec::new();
        if self.paired_root != Some(meta.id) {
            let paths: Vec<String> = self.base.values().map(|e| e.path.clone()).collect();
            for p in paths {
                journal.push(self.record(JournalOp::Remove { path: p }));
            }
            journal.push(self.record(JournalOp::Pair { root: meta.id }));
        }
        self.tree = Some(RemoteTree::from_listing(&meta));
        self.cursor = Some(cursor);
        self.pending_list.clear();
        Ok(journal)
    }

    /// Folders to list with `merge_listing` before the next plan.
    pub fn pending_listings(&self) -> Vec<u64> {
        self.pending_list.iter().copied().collect()
    }

    pub fn apply_diff(&mut self, body: &str) -> Result<DiffOutcome, ApiError> {
        let page = pcloud::parse_diff(body)?;
        let Some(tree) = self.tree.as_mut() else {
            return Ok(DiffOutcome {
                reset: true,
                ..Default::default()
            });
        };
        let result = tree.apply(&page);
        if result.reset {
            self.tree = None;
            self.cursor = None;
            return Ok(DiffOutcome {
                reset: true,
                ..Default::default()
            });
        }
        let caught_up = page.entries.is_empty() || Some(page.diffid) == self.cursor;
        self.cursor = Some(page.diffid);
        self.pending_list
            .extend(result.list_folders.iter().copied());
        Ok(DiffOutcome {
            reset: false,
            list_folders: result.list_folders,
            caught_up,
        })
    }

    pub fn merge_listing(&mut self, listing: &str) -> Result<(), ApiError> {
        let meta = pcloud::parse_metadata(listing)?;
        if let Some(tree) = self.tree.as_mut() {
            tree.merge_listing(&meta);
        }
        self.pending_list.remove(&meta.id);
        Ok(())
    }

    /// None while the remote picture is incomplete: no tree, or folders still to list.
    pub fn plan(&self, input: &PlanInput) -> Option<PlanResult> {
        let tree = self.tree.as_ref()?;
        if !self.pending_list.is_empty() {
            return None;
        }
        Some(planner::plan(input, tree, &self.base, &self.filter))
    }

    pub fn remote_folder(&self, dir: &str) -> Option<u64> {
        self.tree.as_ref()?.find_folder(dir)
    }

    pub fn remote_root(&self) -> Option<u64> {
        self.tree.as_ref().map(RemoteTree::root)
    }

    /// From `createfolderifnotexists`; keeps the tree usable before diff catches up.
    pub fn note_folder(&mut self, body: &str) -> Result<(), ApiError> {
        let meta = pcloud::parse_metadata(body)?;
        if let Some(tree) = self.tree.as_mut() {
            tree.upsert_folder(&meta);
        }
        Ok(())
    }

    pub fn commit_upload(
        &mut self,
        path: &str,
        sha1: &str,
        local: LocalStat,
        body: &str,
    ) -> Result<String, ApiError> {
        let meta = pcloud::parse_upload(body)?;
        let placed = self.tree.as_mut().is_some_and(|t| t.upsert_file(&meta));
        if !placed {
            // Landed in a folder we don't know; relist rather than plan on a hole.
            self.tree = None;
            self.cursor = None;
        }
        let remote = RemoteStat {
            id: meta.id,
            hash: meta.hash.unwrap_or_default(),
            size: meta.size,
            modified: meta.modified,
        };
        Ok(self.put(path, sha1, local, remote))
    }

    pub fn commit_download(
        &mut self,
        path: &str,
        sha1: &str,
        local: LocalStat,
        remote: RemoteStat,
    ) -> String {
        self.put(path, sha1, local, remote)
    }

    pub fn commit_adopt(
        &mut self,
        path: &str,
        sha1: &str,
        local: LocalStat,
        remote: RemoteStat,
    ) -> String {
        self.put(path, sha1, local, remote)
    }

    pub fn commit_rename_local(
        &mut self,
        from: &str,
        to: &str,
        local: LocalStat,
    ) -> Option<String> {
        let entry = self.base.get(&path::key(from))?.clone();
        Some(self.rename(from, to, local, entry.remote, &entry.sha1))
    }

    pub fn commit_rename_remote(
        &mut self,
        from: &str,
        to: &str,
        body: &str,
    ) -> Result<Option<String>, ApiError> {
        let meta = pcloud::parse_metadata(body)?;
        if !self.tree.as_mut().is_some_and(|t| t.upsert_file(&meta)) {
            self.tree = None;
            self.cursor = None;
        }
        let Some(entry) = self.base.get(&path::key(from)).cloned() else {
            return Ok(None);
        };
        let remote = RemoteStat {
            id: meta.id,
            hash: meta.hash.unwrap_or(entry.remote.hash),
            size: meta.size,
            modified: meta.modified,
        };
        Ok(Some(self.rename(
            from,
            to,
            entry.local,
            remote,
            &entry.sha1,
        )))
    }

    /// For `DeleteLocal`, `DeleteRemote` and `Forget`.
    pub fn commit_removed(&mut self, path: &str, remote_id: Option<u64>) -> String {
        if let (Some(id), Some(tree)) = (remote_id, self.tree.as_mut()) {
            tree.remove_file(id);
        }
        self.record(JournalOp::Remove {
            path: path.to_string(),
        })
    }

    fn rename(
        &mut self,
        from: &str,
        to: &str,
        local: LocalStat,
        remote: RemoteStat,
        sha1: &str,
    ) -> String {
        // Same key for case-only renames, so a single put replaces the entry.
        let mut lines = Vec::new();
        if path::key(from) != path::key(to) {
            lines.push(self.record(JournalOp::Remove {
                path: from.to_string(),
            }));
        }
        lines.push(self.put(to, sha1, local, remote));
        lines.join("\n")
    }

    fn put(&mut self, path: &str, sha1: &str, local: LocalStat, remote: RemoteStat) -> String {
        self.record(JournalOp::Put {
            entry: BaseEntry {
                path: path.to_string(),
                sha1: sha1.to_ascii_lowercase(),
                local,
                remote,
            },
        })
    }

    fn record(&mut self, op: JournalOp) -> String {
        self.seq += 1;
        let line = serde_json::to_string(&JournalLine {
            seq: self.seq,
            op: op.clone(),
        })
        .expect("journal line serializes");
        self.apply_op(op);
        line
    }

    fn apply_op(&mut self, op: JournalOp) {
        match op {
            JournalOp::Put { entry } => {
                self.base.insert(path::key(&entry.path), entry);
            }
            JournalOp::Remove { path: p } => {
                self.base.remove(&path::key(&p));
            }
            JournalOp::Pair { root } => {
                self.paired_root = Some(root);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: u64 = 10;

    fn listing(files: &[(u64, &str, u64)]) -> String {
        let contents: Vec<String> = files
            .iter()
            .map(|(id, name, hash)| {
                format!(
                    r#"{{"isfolder":false,"fileid":{id},"parentfolderid":{ROOT},"name":"{name}","size":5,"modified":1,"hash":{hash}}}"#
                )
            })
            .collect();
        format!(
            r#"{{"result":0,"metadata":{{"isfolder":true,"folderid":{ROOT},"name":"Vault","modified":1,"contents":[{}]}}}}"#,
            contents.join(",")
        )
    }

    fn upload_body(id: u64, name: &str, hash: u64) -> String {
        format!(
            r#"{{"result":0,"fileids":[{id}],"metadata":[{{"isfolder":false,"fileid":{id},"parentfolderid":{ROOT},"name":"{name}","size":5,"modified":2,"hash":{hash}}}]}}"#
        )
    }

    fn scan(files: &[(&str, i64)]) -> PlanInput {
        PlanInput {
            local: LocalScan {
                files: files
                    .iter()
                    .map(|(p, mtime)| LocalFile {
                        path: p.to_string(),
                        size: 5,
                        mtime: *mtime,
                        sha1: Some("abc".into()),
                    })
                    .collect(),
                folders: vec![],
            },
            ..Default::default()
        }
    }

    fn actions(engine: &Engine, input: &PlanInput) -> Vec<Action> {
        match engine.plan(input).unwrap() {
            PlanResult::Ready(p) => p.actions,
            other => panic!("{other:?}"),
        }
    }

    const LOCAL: LocalStat = LocalStat {
        size: 5,
        mtime: 1000,
    };

    #[test]
    fn upload_commit_then_nothing_to_do() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        let input = scan(&[("a.md", 1000)]);
        assert!(matches!(actions(&e, &input)[..], [Action::Upload { .. }]));

        e.commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
            .unwrap();
        assert!(actions(&e, &input).is_empty());

        // Our own upload coming back through diff changes nothing.
        let diff = r#"{"result":0,"diffid":5,"entries":[{"diffid":5,"event":"createfile","metadata":
            {"isfolder":false,"fileid":7,"parentfolderid":10,"name":"a.md","size":5,"modified":2,"hash":77}}]}"#;
        e.apply_diff(diff).unwrap();
        assert!(actions(&e, &input).is_empty());
        assert_eq!(e.cursor(), Some(5));
    }

    #[test]
    fn snapshot_and_journal_roundtrip() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[(7, "a.md", 77)]), 1).unwrap();
        let snap = e.snapshot();
        let mut journal = String::new();
        journal.push_str(&e.commit_download(
            "a.md",
            "abc",
            LOCAL,
            RemoteStat {
                id: 7,
                hash: 77,
                size: 5,
                modified: 1,
            },
        ));
        journal.push('\n');
        journal.push_str(r#"{"seq":3,"op":"put","entry":{"path":"#);

        let restored = Engine::load("dev", Some(&snap), Some(&journal)).unwrap();
        assert_eq!(restored.seq(), 2);
        assert_eq!(restored.base_len(), 1);
        assert!(actions(&restored, &scan(&[("a.md", 1000)])).is_empty());
    }

    #[test]
    fn journal_lines_already_in_snapshot_are_skipped() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        let line = e
            .commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
            .unwrap();
        let snap = e.snapshot();
        let removal = e.commit_removed("a.md", Some(7));
        let journal = format!("{line}\n{removal}\n");
        let restored = Engine::load("dev", Some(&snap), Some(&journal)).unwrap();
        assert_eq!(restored.seq(), 3);
        assert_eq!(restored.base_len(), 0);
    }

    #[test]
    fn rejects_state_from_another_device() {
        let e = Engine::new("desktop");
        assert_eq!(
            Engine::load("phone", Some(&e.snapshot()), None).err(),
            Some(LoadError::OtherDevice)
        );
    }

    #[test]
    fn switching_remote_folder_drops_baseline() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        e.commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
            .unwrap();
        let other = listing(&[]).replace(&format!("\"folderid\":{ROOT}"), "\"folderid\":99");
        let lines = e.reset_remote(&other, 2).unwrap();
        assert_eq!(lines.len(), 2, "remove a.md, pair with 99");
        assert_eq!(e.base_len(), 0);
    }

    fn other_root() -> String {
        listing(&[]).replace(&format!("\"folderid\":{ROOT}"), "\"folderid\":99")
    }

    #[test]
    fn switching_folder_after_a_reset_still_drops_baseline() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        e.commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
            .unwrap();
        e.apply_diff(r#"{"result":0,"diffid":9,"entries":[{"diffid":9,"event":"reset"}]}"#)
            .unwrap();
        assert!(!e.has_remote());
        e.reset_remote(&other_root(), 2).unwrap();
        assert_eq!(e.base_len(), 0);
        assert!(actions(&e, &scan(&[("a.md", 1000)]))
            .iter()
            .all(|a| !a.is_delete()));
    }

    #[test]
    fn switching_folder_with_journal_only_state_drops_baseline() {
        // first sync killed before any snapshot: only journal lines survive
        let mut e = Engine::new("dev");
        let mut journal = e.reset_remote(&listing(&[]), 1).unwrap();
        journal.push(
            e.commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
                .unwrap(),
        );
        let mut restored = Engine::load("dev", None, Some(&journal.join("\n"))).unwrap();
        assert_eq!(restored.base_len(), 1);
        restored.reset_remote(&other_root(), 2).unwrap();
        assert_eq!(restored.base_len(), 0);
    }

    #[test]
    fn same_folder_relisting_keeps_baseline() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        e.commit_upload("a.md", "abc", LOCAL, &upload_body(7, "a.md", 77))
            .unwrap();
        let lines = e.reset_remote(&listing(&[(7, "a.md", 77)]), 5).unwrap();
        assert!(lines.is_empty());
        assert_eq!(e.base_len(), 1);
    }

    #[test]
    fn planning_waits_for_folders_to_list() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        let moved_in = r#"{"result":0,"diffid":5,"entries":[{"diffid":5,"event":"modifyfolder","metadata":
            {"isfolder":true,"folderid":20,"parentfolderid":10,"name":"A","modified":1}}]}"#;
        e.apply_diff(moved_in).unwrap();
        assert_eq!(e.pending_listings(), [20]);
        assert!(e.plan(&scan(&[])).is_none());

        // survives a restart
        let mut e = Engine::load("dev", Some(&e.snapshot()), None).unwrap();
        assert!(e.plan(&scan(&[])).is_none());

        let listing_a = r#"{"result":0,"metadata":{"isfolder":true,"folderid":20,"parentfolderid":10,"name":"A",
            "modified":1,"contents":[{"isfolder":false,"fileid":8,"parentfolderid":20,"name":"x.md","size":5,"modified":1,"hash":5}]}}"#;
        e.merge_listing(listing_a).unwrap();
        assert!(e.pending_listings().is_empty());
        assert!(matches!(
            &actions(&e, &scan(&[]))[..],
            [Action::Download { .. }]
        ));
    }

    #[test]
    fn torn_line_in_the_middle_is_skipped() {
        let mut e = Engine::new("dev");
        let mut lines = e.reset_remote(&listing(&[]), 1).unwrap();
        lines.push(r#"{"seq":2,"op":"put","ent"#.to_string());
        lines.push(
            e.commit_upload("b.md", "abc", LOCAL, &upload_body(8, "b.md", 88))
                .unwrap(),
        );
        let restored = Engine::load("dev", None, Some(&lines.join("\n"))).unwrap();
        assert_eq!(restored.base_len(), 1);
    }

    #[test]
    fn rename_to_another_key_replays_the_same() {
        let mut e = Engine::new("dev");
        let mut lines = e.reset_remote(&listing(&[(7, "a.md", 77)]), 1).unwrap();
        lines.push(e.commit_download(
            "a.md",
            "abc",
            LOCAL,
            RemoteStat {
                id: 7,
                hash: 77,
                size: 5,
                modified: 1,
            },
        ));
        lines.push(e.commit_rename_local("a.md", "b.md", LOCAL).unwrap());
        let restored = Engine::load("dev", None, Some(&lines.join("\n"))).unwrap();
        assert_eq!(restored.base_len(), 1);
        assert_eq!(e.base_len(), 1);
    }

    #[test]
    fn upload_into_unknown_folder_forces_relisting() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        let body = r#"{"result":0,"fileids":[9],"metadata":[{"isfolder":false,"fileid":9,"parentfolderid":555,"name":"x.md","size":5,"modified":2,"hash":9}]}"#;
        e.commit_upload("New/x.md", "abc", LOCAL, body).unwrap();
        assert!(!e.has_remote());
    }

    #[test]
    fn diff_reset_clears_remote() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[]), 1).unwrap();
        let out = e
            .apply_diff(r#"{"result":0,"diffid":9,"entries":[{"diffid":9,"event":"reset"}]}"#)
            .unwrap();
        assert!(out.reset);
        assert!(!e.has_remote());
        assert!(e.plan(&PlanInput::default()).is_none());
    }

    #[test]
    fn case_rename_keeps_one_entry() {
        let mut e = Engine::new("dev");
        e.reset_remote(&listing(&[(7, "Note.md", 77)]), 1).unwrap();
        e.commit_download(
            "Note.md",
            "abc",
            LOCAL,
            RemoteStat {
                id: 7,
                hash: 77,
                size: 5,
                modified: 1,
            },
        );
        e.commit_rename_local("Note.md", "note.md", LOCAL).unwrap();
        assert_eq!(e.base_len(), 1);
        let body = r#"{"result":0,"metadata":{"isfolder":false,"fileid":7,"parentfolderid":10,"name":"note.md","size":5,"modified":1,"hash":77}}"#;
        e.commit_rename_remote("note.md", "note.md", body).unwrap();
        assert!(actions(&e, &scan(&[("note.md", 1000)])).is_empty());
    }
}
