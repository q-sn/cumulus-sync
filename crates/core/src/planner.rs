use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::filter::{Filter, Skip};
use crate::model::*;
use crate::path;
use crate::remote_tree::{RemoteFile, RemoteTree};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Absent,
    Unchanged,
    /// Same content as the base, but stat or id moved: refresh the base.
    Stale,
    Changed,
}

struct Ctx<'a> {
    input: &'a PlanInput,
    need_local: BTreeSet<String>,
    need_remote: BTreeSet<u64>,
}

pub fn plan(input: &PlanInput, tree: &RemoteTree, base: &Baseline, filter: &Filter) -> PlanResult {
    let mut local: BTreeMap<String, Vec<&LocalFile>> = BTreeMap::new();
    for f in &input.local.files {
        local.entry(path::key(&f.path)).or_default().push(f);
    }
    let remote_files = tree.files();
    let mut remote: BTreeMap<String, Vec<(&str, &RemoteFile)>> = BTreeMap::new();
    for (p, f) in &remote_files {
        remote
            .entry(path::key(p))
            .or_default()
            .push((p.as_str(), *f));
    }
    let local_folders: HashSet<String> = input.local.folders.iter().map(|p| path::key(p)).collect();
    let remote_folder_paths = tree.folder_paths();
    let remote_folders: HashSet<String> =
        remote_folder_paths.iter().map(|p| path::key(p)).collect();
    // `Notes` and `notes` side by side would be merged into one folder on Android.
    let folder_collisions = colliding(remote_folder_paths.iter().chain(&input.local.folders));
    let mut warned_folders: HashSet<&str> = HashSet::new();

    let scope: Option<HashSet<String>> = match &input.scope {
        Scope::Full => None,
        Scope::Paths(paths) => Some(paths.iter().map(|p| path::key(p)).collect()),
    };

    let keys: BTreeSet<&String> = local
        .keys()
        .chain(remote.keys())
        .chain(base.keys())
        .collect();

    let mut ctx = Ctx {
        input,
        need_local: BTreeSet::new(),
        need_remote: BTreeSet::new(),
    };
    let mut actions = Vec::new();
    let mut warnings = Vec::new();

    for key in keys {
        if scope.as_ref().is_some_and(|s| !s.contains(key)) {
            continue;
        }
        if let Some(folder) = inside_any(key, &folder_collisions) {
            if warned_folders.insert(folder) {
                warnings.push(Warning::Collision {
                    paths: folder_collisions[folder].iter().cloned().collect(),
                });
            }
            continue;
        }
        let locals = local.get(key).map(Vec::as_slice).unwrap_or_default();
        let remotes = remote.get(key).map(Vec::as_slice).unwrap_or_default();
        let b = base.get(key);

        if locals.len() > 1 || remotes.len() > 1 {
            let mut paths: Vec<String> = locals
                .iter()
                .map(|f| f.path.clone())
                .chain(remotes.iter().map(|(p, _)| p.to_string()))
                .collect();
            paths.sort();
            paths.dedup();
            warnings.push(Warning::Collision { paths });
            continue;
        }
        let l = locals.first().copied();
        let r = remotes.first().copied();

        let any_path = l
            .map(|f| f.path.as_str())
            .or(r.map(|(p, _)| p))
            .or(b.map(|b| b.path.as_str()))
            .unwrap_or(key);

        match filter.skip_path(any_path) {
            Some(Skip::Builtin | Skip::Excluded) => {
                if b.is_some() {
                    actions.push(Action::Forget {
                        path: b.map(|b| b.path.clone()).unwrap_or_default(),
                    });
                }
                continue;
            }
            Some(reason) => {
                if l.is_some() || r.is_some() {
                    warnings.push(Warning::Skipped {
                        path: any_path.to_string(),
                        reason,
                    });
                }
                continue;
            }
            None => {}
        }

        if (l.is_some() && remote_folders.contains(key))
            || (r.is_some() && local_folders.contains(key))
        {
            warnings.push(Warning::TypeConflict {
                path: any_path.to_string(),
            });
            continue;
        }

        let too_large = l.is_some_and(|f| filter.too_large(f.size))
            || r.is_some_and(|(_, f)| filter.too_large(f.size));
        if too_large {
            warnings.push(Warning::Skipped {
                path: any_path.to_string(),
                reason: Skip::TooLarge,
            });
            continue;
        }

        let pending = (ctx.need_local.len(), ctx.need_remote.len());
        let mut key_actions = Vec::new();
        decide(&mut ctx, &mut key_actions, l, r, b);
        // Can't decide this path until hashes come back.
        if (ctx.need_local.len(), ctx.need_remote.len()) == pending {
            actions.extend(key_actions);
        }
    }

    if !ctx.need_local.is_empty() || !ctx.need_remote.is_empty() {
        return PlanResult::NeedHashes {
            local: ctx.need_local.into_iter().collect(),
            remote: ctx.need_remote.into_iter().collect(),
        };
    }

    actions.sort_by_key(Action::order);
    let deletes = actions.iter().filter(|a| a.is_delete()).count();
    let guard = if base.is_empty() && !actions.is_empty() {
        Some(Guard::FirstSync)
    } else if deletes > 50 || (deletes >= 3 && deletes * 4 > base.len()) {
        Some(Guard::MassDelete { count: deletes })
    } else {
        None
    };
    PlanResult::Ready(Plan {
        actions,
        warnings,
        guard,
    })
}

fn decide(
    ctx: &mut Ctx,
    out: &mut Vec<Action>,
    l: Option<&LocalFile>,
    r: Option<(&str, &RemoteFile)>,
    b: Option<&BaseEntry>,
) {
    // Local operations use the local spelling, remote ones the remote spelling.
    let (path, rpath) = match (l, r) {
        // Only the Unicode form differs (macOS NFD vs NFC): not a rename.
        (Some(l), Some((rp, _))) if path::normalize(&l.path) == path::normalize(rp) => {
            (l.path.clone(), rp.to_string())
        }
        (Some(l), Some((rp, rf))) => {
            // Same key, different spelling: a case-only rename on one side.
            let local_renamed = b.is_some_and(|b| b.path == rp && b.path != l.path);
            if local_renamed {
                out.push(Action::RenameRemote {
                    from: rp.to_string(),
                    to: l.path.clone(),
                    expect: rf.into(),
                });
                (l.path.clone(), l.path.clone())
            } else {
                out.push(Action::RenameLocal {
                    from: l.path.clone(),
                    to: rp.to_string(),
                    expect: l.into(),
                });
                (rp.to_string(), rp.to_string())
            }
        }
        (Some(l), None) => (l.path.clone(), l.path.clone()),
        (None, Some((rp, _))) => (rp.to_string(), rp.to_string()),
        (None, None) => {
            let p = b.map(|b| b.path.clone()).unwrap_or_default();
            (p.clone(), p)
        }
    };
    let names = Names { path, rpath };
    let ls = l.map(LocalStat::from);
    let rs = r.map(|(_, f)| RemoteStat::from(f));

    let Some(b) = b else {
        match (l, r) {
            (Some(l), None) => out.push(upload(names, l, None)),
            (None, Some(_)) => out.push(download(names.path, rs, None)),
            (Some(l), Some((_, rf))) => both_present(ctx, out, names, l, rf, false),
            (None, None) => {}
        }
        return;
    };

    let local_state = match l {
        None => State::Absent,
        Some(_) if ls == Some(b.local) => State::Unchanged,
        Some(l) => match &l.sha1 {
            None => {
                ctx.need_local.insert(l.path.clone());
                return;
            }
            Some(h) if h.eq_ignore_ascii_case(&b.sha1) => State::Stale,
            Some(_) => State::Changed,
        },
    };
    let remote_state = match rs {
        None => State::Absent,
        Some(s) if s == b.remote => State::Unchanged,
        Some(s) if s.hash == b.remote.hash && s.size == b.remote.size => State::Stale,
        Some(_) => State::Changed,
    };

    use State::*;
    match (local_state, remote_state) {
        (Unchanged, Unchanged) => {}
        (Unchanged | Stale, Unchanged | Stale) => out.push(Action::Adopt {
            path: names.path,
            sha1: b.sha1.clone(),
            local: ls.unwrap_or(b.local),
            remote: rs.unwrap_or(b.remote),
        }),
        (Changed, Unchanged | Stale) => out.push(upload(names, l.unwrap(), rs)),
        (Unchanged | Stale, Changed) => out.push(download(names.path, rs, ls)),
        (Changed, Changed) => both_present(ctx, out, names, l.unwrap(), r.unwrap().1, true),
        (Absent, Unchanged | Stale) => out.push(Action::DeleteRemote {
            path: names.rpath,
            expect: rs.unwrap(),
        }),
        (Unchanged | Stale, Absent) => out.push(Action::DeleteLocal {
            path: names.path,
            expect: ls.unwrap(),
        }),
        // An edit wins over a delete.
        (Absent, Changed) => out.push(download(names.path, rs, None)),
        (Changed, Absent) => out.push(upload(names, l.unwrap(), None)),
        (Absent, Absent) => out.push(Action::Forget { path: names.path }),
    }
}

/// Both sides have content that may differ and there is no usable base for it.
fn both_present(
    ctx: &mut Ctx,
    out: &mut Vec<Action>,
    names: Names,
    l: &LocalFile,
    r: &RemoteFile,
    had_base: bool,
) {
    let ls = LocalStat::from(l);
    let rs = RemoteStat::from(r);

    if !had_base {
        // A fresh empty note (daily note template off, new file) never wins over content.
        if l.size == 0 && r.size > 0 {
            out.push(download(names.path, Some(rs), Some(ls)));
            return;
        }
        if r.size == 0 && l.size > 0 {
            out.push(upload(names, l, Some(rs)));
            return;
        }
    }

    if l.size == r.size {
        let local_sha1 = l.sha1.as_ref();
        let remote_sha1 = ctx.input.remote_sha1.get(&r.id);
        if local_sha1.is_none() {
            ctx.need_local.insert(l.path.clone());
        }
        if remote_sha1.is_none() {
            ctx.need_remote.insert(r.id);
        }
        let (Some(a), Some(b)) = (local_sha1, remote_sha1) else {
            return;
        };
        if a.eq_ignore_ascii_case(b) {
            out.push(Action::Adopt {
                path: names.path,
                sha1: a.to_ascii_lowercase(),
                local: ls,
                remote: rs,
            });
            return;
        }
    }

    let mode = if had_base {
        FirstSync::Merge
    } else {
        ctx.input.first_sync
    };
    match mode {
        FirstSync::PreferRemote => out.push(download(names.path, Some(rs), Some(ls))),
        FirstSync::PreferLocal => out.push(upload(names, l, Some(rs))),
        FirstSync::Merge => out.push(Action::Conflict {
            copy: path::conflict_copy(&names.path, &ctx.input.stamp, &ctx.input.device),
            remote_path: names.remote_override(),
            path: names.path,
            local: ls,
            remote: rs,
        }),
    }
}

/// Local and remote spelling of one path; they differ only in Unicode form.
struct Names {
    path: String,
    rpath: String,
}

impl Names {
    fn remote_override(&self) -> Option<String> {
        (self.rpath != self.path).then(|| self.rpath.clone())
    }
}

fn upload(names: Names, l: &LocalFile, replace: Option<RemoteStat>) -> Action {
    Action::Upload {
        remote_path: names.remote_override(),
        path: names.path,
        sha1: l.sha1.clone(),
        local: l.into(),
        replace,
    }
}

/// Folder keys spelled more than one way, with their spellings.
fn colliding<'a>(paths: impl Iterator<Item = &'a String>) -> BTreeMap<String, BTreeSet<String>> {
    let mut by_key: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in paths {
        // compare per level, so `A/b` and `a/b` collide at `a`, not at `a/b`
        let mut prefix = String::new();
        for part in p.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            by_key
                .entry(path::key(&prefix))
                .or_default()
                .insert(path::normalize(&prefix));
        }
    }
    by_key.retain(|_, spellings| spellings.len() > 1);
    by_key
}

fn inside_any<'a>(key: &str, folders: &'a BTreeMap<String, BTreeSet<String>>) -> Option<&'a str> {
    if folders.is_empty() {
        return None;
    }
    key.match_indices('/')
        .map(|(i, _)| &key[..i])
        .find_map(|dir| folders.get_key_value(dir).map(|(k, _)| k.as_str()))
}

fn download(path: String, remote: Option<RemoteStat>, replace: Option<LocalStat>) -> Action {
    Action::Download {
        path,
        remote: remote.expect("download needs a remote file"),
        replace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::FilterConfig;
    use crate::pcloud::Metadata;

    const ROOT: u64 = 1;

    struct World {
        local: Vec<LocalFile>,
        local_folders: Vec<String>,
        remote: Vec<Metadata>,
        base: Baseline,
        first_sync: FirstSync,
        remote_sha1: Vec<(u64, &'static str)>,
        scope: Scope,
        filter: FilterConfig,
    }

    impl World {
        fn new() -> Self {
            World {
                local: vec![],
                local_folders: vec![],
                remote: vec![],
                base: Baseline::new(),
                first_sync: FirstSync::Merge,
                remote_sha1: vec![],
                scope: Scope::Full,
                filter: FilterConfig::default(),
            }
        }

        fn local(mut self, path: &str, size: u64, mtime: i64, sha1: Option<&str>) -> Self {
            self.local.push(LocalFile {
                path: path.into(),
                size,
                mtime,
                sha1: sha1.map(Into::into),
            });
            self
        }

        /// Files only at the root or in folders created by `remote_folder`.
        fn remote(mut self, id: u64, name: &str, size: u64, hash: u64) -> Self {
            self.remote.push(meta(id, ROOT, name, size, hash));
            self
        }

        fn base(
            mut self,
            path: &str,
            sha1: &str,
            local: (u64, i64),
            remote: (u64, u64, u64),
        ) -> Self {
            self.base.insert(
                path::key(path),
                BaseEntry {
                    path: path.into(),
                    sha1: sha1.into(),
                    local: LocalStat {
                        size: local.0,
                        mtime: local.1,
                    },
                    remote: RemoteStat {
                        id: remote.0,
                        hash: remote.1,
                        size: remote.2,
                        modified: 0,
                    },
                },
            );
            self
        }

        /// Base for an unchanged file `path`: local (size 5, mtime 1000), remote (id, hash 50).
        fn synced(self, path: &str, id: u64) -> Self {
            let name = path.to_string();
            self.base(&name, "s", (5, 1000), (id, 50, 5))
                .local(&name, 5, 1000, None)
                .remote(id, &name, 5, 50)
        }

        fn run(&self) -> PlanResult {
            let mut root = meta(ROOT, 0, "Vault", 0, 0);
            root.is_folder = true;
            root.contents = Some(self.remote.clone());
            let tree = RemoteTree::from_listing(&root);
            let input = PlanInput {
                scope: self.scope.clone(),
                local: LocalScan {
                    files: self.local.clone(),
                    folders: self.local_folders.clone(),
                },
                first_sync: self.first_sync,
                remote_sha1: self
                    .remote_sha1
                    .iter()
                    .map(|(id, h)| (*id, h.to_string()))
                    .collect(),
                stamp: "2026-10-19 1432".into(),
                device: "pixel".into(),
            };
            plan(&input, &tree, &self.base, &Filter::new(&self.filter))
        }

        fn ready(&self) -> Plan {
            match self.run() {
                PlanResult::Ready(p) => p,
                other => panic!("expected a plan, got {other:?}"),
            }
        }

        fn kinds(&self) -> Vec<String> {
            self.ready()
                .actions
                .iter()
                .map(|a| {
                    let v = serde_json::to_value(a).unwrap();
                    format!("{} {}", v["kind"].as_str().unwrap(), a.path())
                })
                .collect()
        }
    }

    fn meta(id: u64, parent: u64, name: &str, size: u64, hash: u64) -> Metadata {
        Metadata {
            is_folder: false,
            id,
            parent: Some(parent),
            name: name.into(),
            size,
            modified: 0,
            hash: Some(hash),
            is_deleted: false,
            deleted_file_id: None,
            contents: None,
        }
    }

    fn with_base(w: World) -> World {
        // Keeps the base non-empty so the first-sync guard stays out of the way.
        w.synced("anchor.md", 999)
    }

    #[test]
    fn nothing_to_do() {
        let w = with_base(World::new());
        assert!(w.ready().actions.is_empty());
        assert_eq!(w.ready().guard, None);
    }

    #[test]
    fn new_files_both_ways() {
        let w = with_base(World::new())
            .local("mine.md", 3, 1, None)
            .remote(2, "theirs.md", 4, 40);
        assert_eq!(w.kinds(), ["upload mine.md", "download theirs.md"]);
    }

    #[test]
    fn local_edit_uploads() {
        let w = with_base(World::new())
            .base("a.md", "old", (5, 1000), (2, 50, 5))
            .local("a.md", 6, 2000, Some("new"))
            .remote(2, "a.md", 5, 50);
        let plan = w.ready();
        assert_eq!(
            plan.actions,
            [Action::Upload {
                path: "a.md".into(),
                remote_path: None,
                sha1: Some("new".into()),
                local: LocalStat {
                    size: 6,
                    mtime: 2000
                },
                replace: Some(RemoteStat {
                    id: 2,
                    hash: 50,
                    size: 5,
                    modified: 0
                }),
            }]
        );
    }

    #[test]
    fn touched_but_same_content_only_refreshes_base() {
        let w = with_base(World::new())
            .base("a.md", "same", (5, 1000), (2, 50, 5))
            .local("a.md", 5, 9999, Some("same"))
            .remote(2, "a.md", 5, 50);
        assert_eq!(w.kinds(), ["adopt a.md"]);
    }

    #[test]
    fn changed_stat_needs_hash_first() {
        let w = with_base(World::new())
            .base("a.md", "old", (5, 1000), (2, 50, 5))
            .local("a.md", 5, 2000, None)
            .remote(2, "a.md", 5, 50);
        assert_eq!(
            w.run(),
            PlanResult::NeedHashes {
                local: vec!["a.md".into()],
                remote: vec![]
            }
        );
    }

    #[test]
    fn remote_edit_downloads() {
        let w = with_base(World::new())
            .base("a.md", "old", (5, 1000), (2, 50, 5))
            .local("a.md", 5, 1000, None)
            .remote(2, "a.md", 7, 51);
        assert_eq!(w.kinds(), ["download a.md"]);
    }

    #[test]
    fn deletes_propagate() {
        let w = with_base(World::new())
            .base("gone-here.md", "x", (5, 1000), (2, 50, 5))
            .remote(2, "gone-here.md", 5, 50)
            .base("gone-there.md", "y", (5, 1000), (3, 60, 5))
            .local("gone-there.md", 5, 1000, None)
            .base("gone-both.md", "z", (5, 1000), (4, 70, 5));
        assert_eq!(
            w.kinds(),
            [
                "forget gone-both.md",
                "deleteRemote gone-here.md",
                "deleteLocal gone-there.md"
            ]
        );
    }

    #[test]
    fn edit_beats_delete() {
        let w = with_base(World::new())
            .base("edited-remote.md", "x", (5, 1000), (2, 50, 5))
            .remote(2, "edited-remote.md", 6, 51)
            .base("edited-local.md", "y", (5, 1000), (3, 60, 5))
            .local("edited-local.md", 6, 2000, Some("y2"));
        assert_eq!(
            w.kinds(),
            ["upload edited-local.md", "download edited-remote.md"]
        );
    }

    #[test]
    fn both_edited_differently_is_a_conflict() {
        let w = with_base(World::new())
            .base("a.md", "old", (5, 1000), (2, 50, 5))
            .local("a.md", 6, 2000, Some("mine"))
            .remote(2, "a.md", 7, 51);
        match &w.ready().actions[..] {
            [Action::Conflict { path, copy, .. }] => {
                assert_eq!(path, "a.md");
                assert_eq!(copy, "a (conflict 2026-10-19 1432 pixel).md");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn both_edited_to_same_content_is_adopted() {
        // Also the recovery path after a crash between upload and commit.
        let mut w = with_base(World::new())
            .base("a.md", "old", (5, 1000), (2, 50, 5))
            .local("a.md", 6, 2000, Some("new"))
            .remote(2, "a.md", 6, 51);
        assert_eq!(
            w.run(),
            PlanResult::NeedHashes {
                local: vec![],
                remote: vec![2]
            }
        );
        w.remote_sha1.push((2, "NEW"));
        assert_eq!(w.kinds(), ["adopt a.md"]);
    }

    #[test]
    fn first_sync_strategies() {
        let w = World::new()
            .local("a.md", 5, 1, Some("l"))
            .remote(2, "a.md", 6, 60)
            .local("same.md", 5, 1, Some("eq"))
            .remote(3, "same.md", 5, 70);
        let mut merge = w;
        merge.remote_sha1.push((3, "eq"));
        assert_eq!(merge.kinds(), ["adopt same.md", "conflict a.md"]);
        assert_eq!(merge.ready().guard, Some(Guard::FirstSync));

        merge.first_sync = FirstSync::PreferRemote;
        assert_eq!(merge.kinds(), ["adopt same.md", "download a.md"]);
        merge.first_sync = FirstSync::PreferLocal;
        assert_eq!(merge.kinds(), ["adopt same.md", "upload a.md"]);
    }

    #[test]
    fn empty_file_loses_on_first_sync() {
        let w = World::new()
            .local("daily.md", 0, 1, None)
            .remote(2, "daily.md", 120, 60)
            .local("draft.md", 30, 1, None)
            .remote(3, "draft.md", 0, 0);
        assert_eq!(w.kinds(), ["download daily.md", "upload draft.md"]);
    }

    #[test]
    fn case_collision_is_left_alone() {
        let w = with_base(World::new())
            .remote(2, "Note.md", 1, 1)
            .remote(3, "note.md", 2, 2);
        let plan = w.ready();
        assert!(plan.actions.is_empty());
        assert_eq!(
            plan.warnings,
            [Warning::Collision {
                paths: vec!["Note.md".into(), "note.md".into()]
            }]
        );
    }

    #[test]
    fn nfd_and_nfc_names_match() {
        let w = with_base(World::new())
            .base("Café.md", "s", (5, 1000), (2, 50, 5))
            .local("Cafe\u{301}.md", 5, 1000, None)
            .remote(2, "Café.md", 5, 50);
        assert!(w.kinds().is_empty());
    }

    #[test]
    fn case_only_rename_on_desktop_renames_local() {
        let w = with_base(World::new())
            .base("Note.md", "s", (5, 1000), (2, 50, 5))
            .local("Note.md", 5, 1000, None)
            .remote(2, "note.md", 5, 50);
        assert_eq!(w.kinds(), ["renameLocal note.md"]);
    }

    #[test]
    fn case_only_rename_on_phone_renames_remote() {
        let w = with_base(World::new())
            .base("Note.md", "s", (5, 1000), (2, 50, 5))
            .local("NOTE.md", 5, 1000, None)
            .remote(2, "Note.md", 5, 50);
        assert_eq!(w.kinds(), ["renameRemote NOTE.md"]);
    }

    #[test]
    fn excluded_paths_are_forgotten_not_deleted() {
        let mut w = with_base(World::new()).synced("Private/diary.md", 2);
        w.local.retain(|f| f.path != "Private/diary.md");
        w.filter.exclude.push("private/**".into());
        assert_eq!(w.kinds(), ["forget Private/diary.md"]);
    }

    #[test]
    fn config_dir_is_never_touched() {
        let w = with_base(World::new())
            .local(".obsidian/app.json", 3, 1, None)
            .local(".trash/old.md", 3, 1, None);
        assert!(w.ready().actions.is_empty());
    }

    #[test]
    fn too_large_is_skipped_and_kept_in_base() {
        let mut w = with_base(World::new())
            .base("big.mp4", "s", (500, 1000), (2, 50, 500))
            .local("big.mp4", 600, 2000, None)
            .remote(2, "big.mp4", 500, 50);
        w.filter.max_file_size = Some(100);
        let plan = w.ready();
        assert!(plan.actions.is_empty());
        assert_eq!(
            plan.warnings,
            [Warning::Skipped {
                path: "big.mp4".into(),
                reason: Skip::TooLarge
            }]
        );
    }

    #[test]
    fn file_vs_folder() {
        let mut w = with_base(World::new()).remote(2, "Ideas", 3, 3);
        w.local_folders.push("ideas".into());
        assert_eq!(
            w.ready().warnings,
            [Warning::TypeConflict {
                path: "Ideas".into()
            }]
        );
        assert!(w.ready().actions.is_empty());
    }

    #[test]
    fn partial_scope_never_deletes_unscanned_files() {
        let mut w = with_base(World::new())
            .base("other.md", "s", (5, 1000), (3, 50, 5))
            .remote(3, "other.md", 5, 50)
            .local("dirty.md", 3, 1, None);
        w.scope = Scope::Paths(vec!["dirty.md".into()]);
        assert_eq!(w.kinds(), ["upload dirty.md"]);
    }

    #[test]
    fn mass_delete_guard() {
        let mut w = World::new();
        for i in 0..20u64 {
            w = w.base(&format!("n{i}.md"), "s", (5, 1000), (100 + i, 50, 5));
            if i < 15 {
                w = w.remote(100 + i, &format!("n{i}.md"), 5, 50);
            } else {
                w = w.local(&format!("n{i}.md"), 5, 1000, None).remote(
                    100 + i,
                    &format!("n{i}.md"),
                    5,
                    50,
                );
            }
        }
        let plan = w.ready();
        assert_eq!(plan.actions.len(), 15);
        assert_eq!(plan.guard, Some(Guard::MassDelete { count: 15 }));
    }

    #[test]
    fn hashes_are_requested_in_one_round() {
        let w = World::new()
            .local("a.md", 5, 1, None)
            .remote(2, "a.md", 5, 1)
            .local("b.md", 5, 1, None)
            .remote(3, "b.md", 5, 2);
        assert_eq!(
            w.run(),
            PlanResult::NeedHashes {
                local: vec!["a.md".into(), "b.md".into()],
                remote: vec![2, 3]
            }
        );
    }

    #[test]
    fn nfd_local_name_keeps_both_spellings() {
        let w = with_base(World::new())
            .base("Café.md", "s", (5, 1000), (2, 50, 5))
            .local("Cafe\u{301}.md", 6, 2000, Some("new"))
            .remote(2, "Café.md", 5, 50);
        match &w.ready().actions[..] {
            [Action::Upload {
                path, remote_path, ..
            }] => {
                assert_eq!(path, "Cafe\u{301}.md");
                assert_eq!(remote_path.as_deref(), Some("Café.md"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn folders_differing_in_case_are_left_alone() {
        let mut w = with_base(World::new());
        w.remote
            .push(folder_meta(30, "Notes", vec![meta(31, 30, "a.md", 1, 1)]));
        w.remote
            .push(folder_meta(32, "notes", vec![meta(33, 32, "b.md", 1, 1)]));
        w.local_folders.push("Notes".into());
        w = w.local("Notes/b.md", 1, 1, None);
        w = w.base("notes/b.md", "s", (1, 1), (33, 1, 1));
        let plan = w.ready();
        assert!(plan.actions.is_empty(), "{:?}", plan.actions);
        assert!(matches!(&plan.warnings[..], [Warning::Collision { .. }]));
    }

    #[test]
    fn uppercase_local_hash_is_not_a_change() {
        let w = with_base(World::new())
            .base("a.md", "abc", (5, 1000), (2, 50, 5))
            .local("a.md", 5, 2000, Some("ABC"))
            .remote(2, "a.md", 5, 50);
        assert_eq!(w.kinds(), ["adopt a.md"]);
    }

    #[test]
    fn small_vault_wipe_asks_first() {
        let mut w = World::new();
        for i in 0..4u64 {
            w = w
                .base(&format!("n{i}.md"), "s", (5, 1000), (100 + i, 50, 5))
                .remote(100 + i, &format!("n{i}.md"), 5, 50);
        }
        assert_eq!(w.ready().guard, Some(Guard::MassDelete { count: 4 }));
    }

    fn folder_meta(id: u64, name: &str, contents: Vec<Metadata>) -> Metadata {
        Metadata {
            is_folder: true,
            id,
            parent: Some(ROOT),
            name: name.into(),
            size: 0,
            modified: 0,
            hash: None,
            is_deleted: false,
            deleted_file_id: None,
            contents: Some(contents),
        }
    }
}
