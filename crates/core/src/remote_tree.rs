use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::path;
use crate::pcloud::{DiffEvent, DiffPage, Metadata};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteFile {
    pub id: u64,
    pub parent: u64,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub hash: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Folder {
    parent: u64,
    name: String,
}

/// Vault folder in pCloud, kept current from `diff`. Stored by id, not path,
/// so renaming a folder is a single update.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteTree {
    root: u64,
    folders: HashMap<u64, Folder>,
    files: HashMap<u64, RemoteFile>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ApplyResult {
    /// Full relisting needed: pCloud sent `reset`, or the vault folder is gone.
    pub reset: bool,
    /// Folders that came into the vault from elsewhere. pCloud sends one event
    /// for the folder and nothing for its contents, so they have to be listed.
    pub list_folders: Vec<u64>,
}

impl RemoteTree {
    pub fn new(root: u64) -> Self {
        RemoteTree {
            root,
            ..Default::default()
        }
    }

    /// From a recursive `listfolder` of the vault folder.
    pub fn from_listing(listing: &Metadata) -> Self {
        let mut tree = RemoteTree::new(listing.id);
        tree.insert_children(listing);
        tree
    }

    pub fn root(&self) -> u64 {
        self.root
    }

    /// Adds a recursive listing of a folder that is already in the tree.
    pub fn merge_listing(&mut self, listing: &Metadata) {
        if listing.id == self.root || self.folders.contains_key(&listing.id) {
            self.insert_children(listing);
        }
    }

    fn insert_children(&mut self, folder: &Metadata) {
        for item in folder.contents.iter().flatten() {
            if item.is_deleted {
                continue;
            }
            if item.is_folder {
                self.folders.insert(
                    item.id,
                    Folder {
                        parent: folder.id,
                        name: item.name.clone(),
                    },
                );
                self.insert_children(item);
            } else if let Some(file) = to_file(item, folder.id) {
                self.files.insert(file.id, file);
            }
        }
    }

    pub fn apply(&mut self, page: &DiffPage) -> ApplyResult {
        let mut result = ApplyResult::default();
        for entry in &page.entries {
            match &entry.event {
                DiffEvent::Reset => {
                    result.reset = true;
                    return result;
                }
                DiffEvent::CreateFolder(m) | DiffEvent::ModifyFolder(m) => {
                    if m.id == self.root {
                        continue;
                    }
                    let inside = m.parent.is_some_and(|p| self.has_folder(p));
                    let known = self.folders.contains_key(&m.id);
                    match (inside, known) {
                        (true, _) => {
                            self.folders.insert(
                                m.id,
                                Folder {
                                    parent: m.parent.unwrap_or_default(),
                                    name: m.name.clone(),
                                },
                            );
                            if !known && matches!(entry.event, DiffEvent::ModifyFolder(_)) {
                                result.list_folders.push(m.id);
                            }
                        }
                        (false, true) => self.remove_folder(m.id),
                        (false, false) => {}
                    }
                }
                DiffEvent::DeleteFolder(m) => {
                    if m.id == self.root {
                        result.reset = true;
                        return result;
                    }
                    self.remove_folder(m.id);
                }
                DiffEvent::CreateFile(m) | DiffEvent::ModifyFile(m) => {
                    if let Some(replaced) = m.deleted_file_id {
                        self.files.remove(&replaced);
                    }
                    let parent = m.parent.unwrap_or_default();
                    match to_file(m, parent) {
                        Some(file) if self.has_folder(parent) => {
                            self.files.insert(file.id, file);
                        }
                        _ => {
                            self.files.remove(&m.id);
                        }
                    }
                }
                DiffEvent::DeleteFile(m) => {
                    self.files.remove(&m.id);
                }
                DiffEvent::Other(_) => {}
            }
        }
        // A folder listed above may have been dropped by a later event.
        result.list_folders.retain(|id| self.folders.contains_key(id));
        result
    }

    /// Records the result of our own upload before its diff event arrives.
    pub fn upsert_file(&mut self, m: &Metadata) {
        let parent = m.parent.unwrap_or_default();
        if let Some(replaced) = m.deleted_file_id {
            self.files.remove(&replaced);
        }
        if let Some(file) = to_file(m, parent) {
            if self.has_folder(parent) {
                self.files.insert(file.id, file);
            }
        }
    }

    pub fn upsert_folder(&mut self, m: &Metadata) {
        if let Some(parent) = m.parent {
            if m.id != self.root && self.has_folder(parent) {
                self.folders.insert(
                    m.id,
                    Folder {
                        parent,
                        name: m.name.clone(),
                    },
                );
            }
        }
    }

    pub fn remove_file(&mut self, id: u64) {
        self.files.remove(&id);
    }

    fn has_folder(&self, id: u64) -> bool {
        id == self.root || self.folders.contains_key(&id)
    }

    fn remove_folder(&mut self, id: u64) {
        let mut doomed: HashSet<u64> = HashSet::from([id]);
        loop {
            let before = doomed.len();
            for (fid, folder) in &self.folders {
                if doomed.contains(&folder.parent) {
                    doomed.insert(*fid);
                }
            }
            if doomed.len() == before {
                break;
            }
        }
        self.folders.retain(|fid, _| !doomed.contains(fid));
        self.files.retain(|_, f| !doomed.contains(&f.parent));
    }

    /// Vault-relative path of a folder, `""` for the root.
    pub fn folder_path(&self, id: u64) -> Option<String> {
        let mut parts = Vec::new();
        let mut current = id;
        let mut guard = 0;
        while current != self.root {
            let folder = self.folders.get(&current)?;
            parts.push(folder.name.as_str());
            current = folder.parent;
            guard += 1;
            if guard > 4096 {
                return None;
            }
        }
        parts.reverse();
        Some(parts.join("/"))
    }

    pub fn file_path(&self, file: &RemoteFile) -> Option<String> {
        let dir = self.folder_path(file.parent)?;
        Some(path::join(&dir, &file.name))
    }

    /// Every file with its vault-relative path, sorted by path.
    pub fn files(&self) -> Vec<(String, &RemoteFile)> {
        let mut dirs: HashMap<u64, Option<String>> = HashMap::new();
        let mut out: Vec<(String, &RemoteFile)> = self
            .files
            .values()
            .filter_map(|f| {
                let dir = dirs
                    .entry(f.parent)
                    .or_insert_with(|| self.folder_path(f.parent))
                    .clone()?;
                Some((path::join(&dir, &f.name), f))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Every folder path except the root, sorted.
    pub fn folder_paths(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .folders
            .keys()
            .filter_map(|id| self.folder_path(*id))
            .collect();
        out.sort();
        out
    }

    /// Folder id by vault-relative path, matched by name exactly.
    pub fn find_folder(&self, dir: &str) -> Option<u64> {
        if dir.is_empty() {
            return Some(self.root);
        }
        let mut current = self.root;
        for part in dir.split('/') {
            current = *self
                .folders
                .iter()
                .find(|(_, f)| f.parent == current && f.name == part)?
                .0;
        }
        Some(current)
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }
}

fn to_file(m: &Metadata, parent: u64) -> Option<RemoteFile> {
    if m.is_folder || m.is_deleted {
        return None;
    }
    Some(RemoteFile {
        id: m.id,
        parent,
        name: m.name.clone(),
        size: m.size,
        modified: m.modified,
        hash: m.hash.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pcloud::DiffEntry;

    fn file(id: u64, parent: u64, name: &str, hash: u64) -> Metadata {
        Metadata {
            is_folder: false,
            id,
            parent: Some(parent),
            name: name.into(),
            size: 1,
            modified: 1,
            hash: Some(hash),
            is_deleted: false,
            deleted_file_id: None,
            contents: None,
        }
    }

    fn folder(id: u64, parent: u64, name: &str, contents: Vec<Metadata>) -> Metadata {
        Metadata {
            is_folder: true,
            id,
            parent: Some(parent),
            name: name.into(),
            size: 0,
            modified: 1,
            hash: None,
            is_deleted: false,
            deleted_file_id: None,
            contents: Some(contents),
        }
    }

    fn page(events: Vec<DiffEvent>) -> DiffPage {
        DiffPage {
            diffid: 1,
            entries: events
                .into_iter()
                .enumerate()
                .map(|(i, event)| DiffEntry {
                    diffid: i as u64,
                    event,
                })
                .collect(),
        }
    }

    // Vault (10): a.md, Sub (11): b.md
    fn tree() -> RemoteTree {
        RemoteTree::from_listing(&folder(
            10,
            0,
            "Vault",
            vec![
                file(1, 10, "a.md", 100),
                folder(11, 10, "Sub", vec![file(2, 11, "b.md", 200)]),
            ],
        ))
    }

    fn paths(t: &RemoteTree) -> Vec<String> {
        t.files().into_iter().map(|(p, _)| p).collect()
    }

    #[test]
    fn listing() {
        let t = tree();
        assert_eq!(paths(&t), ["Sub/b.md", "a.md"]);
        assert_eq!(t.folder_paths(), ["Sub"]);
        assert_eq!(t.find_folder("Sub"), Some(11));
        assert_eq!(t.find_folder(""), Some(10));
        assert_eq!(t.find_folder("Nope"), None);
    }

    #[test]
    fn create_modify_delete_files() {
        let mut t = tree();
        t.apply(&page(vec![
            DiffEvent::CreateFile(file(3, 11, "c.md", 300)),
            DiffEvent::ModifyFile(file(1, 10, "a.md", 101)),
            DiffEvent::DeleteFile(file(2, 11, "b.md", 200)),
            DiffEvent::CreateFile(file(9, 999, "elsewhere.md", 1)),
        ]));
        assert_eq!(paths(&t), ["Sub/c.md", "a.md"]);
        assert_eq!(t.files().iter().find(|(p, _)| p == "a.md").unwrap().1.hash, 101);
    }

    #[test]
    fn file_rename_and_move_out() {
        let mut t = tree();
        t.apply(&page(vec![
            DiffEvent::ModifyFile(file(1, 11, "renamed.md", 100)),
            DiffEvent::ModifyFile(file(2, 999, "b.md", 200)),
        ]));
        assert_eq!(paths(&t), ["Sub/renamed.md"]);
    }

    #[test]
    fn atomic_replace_drops_old_id() {
        let mut t = tree();
        let mut new = file(5, 10, "a.md", 555);
        new.deleted_file_id = Some(1);
        t.apply(&page(vec![DiffEvent::CreateFile(new)]));
        let files = t.files();
        assert_eq!(files.len(), 2);
        assert_eq!(files.iter().find(|(p, _)| p == "a.md").unwrap().1.id, 5);
    }

    #[test]
    fn folder_rename_moves_children() {
        let mut t = tree();
        t.apply(&page(vec![DiffEvent::ModifyFolder(folder(11, 10, "Renamed", vec![]))]));
        assert_eq!(paths(&t), ["Renamed/b.md", "a.md"]);
    }

    #[test]
    fn folder_moved_in_needs_listing() {
        let mut t = tree();
        let r = t.apply(&page(vec![
            DiffEvent::ModifyFolder(folder(20, 10, "Imported", vec![])),
            DiffEvent::CreateFolder(folder(21, 10, "Fresh", vec![])),
        ]));
        assert_eq!(r.list_folders, [20]);
        t.merge_listing(&folder(20, 10, "Imported", vec![file(7, 20, "x.md", 7)]));
        assert_eq!(paths(&t), ["Imported/x.md", "Sub/b.md", "a.md"]);
        assert_eq!(t.folder_paths(), ["Fresh", "Imported", "Sub"]);
    }

    #[test]
    fn folder_moved_out_drops_subtree() {
        let mut t = tree();
        t.apply(&page(vec![DiffEvent::ModifyFolder(folder(11, 999, "Sub", vec![]))]));
        assert_eq!(paths(&t), ["a.md"]);
        assert!(t.folder_paths().is_empty());
    }

    #[test]
    fn nested_folder_delete() {
        let mut t = tree();
        t.apply(&page(vec![
            DiffEvent::CreateFolder(folder(12, 11, "Deep", vec![])),
            DiffEvent::CreateFile(file(4, 12, "d.md", 4)),
            DiffEvent::DeleteFolder(folder(11, 10, "Sub", vec![])),
        ]));
        assert_eq!(paths(&t), ["a.md"]);
    }

    #[test]
    fn reset_and_root_deletion() {
        let mut t = tree();
        assert!(t.apply(&page(vec![DiffEvent::Reset])).reset);
        assert!(t.apply(&page(vec![DiffEvent::DeleteFolder(folder(10, 0, "Vault", vec![]))])).reset);
    }

    #[test]
    fn listed_folder_dropped_later_in_page() {
        let mut t = tree();
        let r = t.apply(&page(vec![
            DiffEvent::ModifyFolder(folder(20, 10, "Imported", vec![])),
            DiffEvent::DeleteFolder(folder(20, 10, "Imported", vec![])),
        ]));
        assert!(r.list_folders.is_empty());
    }

    #[test]
    fn snapshot_roundtrip() {
        let t = tree();
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<RemoteTree>(&json).unwrap(), t);
    }
}
