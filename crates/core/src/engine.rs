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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum JournalOp {
    Put { entry: BaseEntry },
    Remove { path: String },
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
            // A torn last line means the app died mid-write; that commit never happened.
            let Ok(entry) = serde_json::from_str::<JournalLine>(line) else {
                break;
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

    /// Fresh recursive listing of the vault folder. Pointing at a different
    /// folder than before drops the baseline: it describes another pairing.
    pub fn reset_remote(&mut self, listing: &str, cursor: u64) -> Result<Vec<String>, ApiError> {
        let meta = pcloud::parse_metadata(listing)?;
        let mut journal = Vec::new();
        if self.tree.as_ref().is_some_and(|t| t.root() != meta.id) {
            let paths: Vec<String> = self.base.values().map(|e| e.path.clone()).collect();
            for p in paths {
                journal.push(self.record(JournalOp::Remove { path: p }));
            }
        }
        self.tree = Some(RemoteTree::from_listing(&meta));
        self.cursor = Some(cursor);
        Ok(journal)
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
        Ok(())
    }

    pub fn plan(&self, input: &PlanInput) -> Option<PlanResult> {
        let tree = self.tree.as_ref()?;
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
        if let Some(tree) = self.tree.as_mut() {
            tree.upsert_file(&meta);
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
        if let Some(tree) = self.tree.as_mut() {
            tree.upsert_file(&meta);
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
        if path::key(from) != path::key(to) {
            self.base.remove(&path::key(from));
        }
        self.put(to, sha1, local, remote)
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
        journal.push_str(r#"{"seq":2,"op":"put","entry":{"path":"#);

        let restored = Engine::load("dev", Some(&snap), Some(&journal)).unwrap();
        assert_eq!(restored.seq(), 1);
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
        assert_eq!(restored.seq(), 2);
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
        assert_eq!(lines.len(), 1);
        assert_eq!(e.base_len(), 0);
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
