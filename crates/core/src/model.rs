use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::filter::Skip;
use crate::remote_tree::RemoteFile;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub size: u64,
    /// ms
    #[serde(deserialize_with = "ms")]
    pub mtime: i64,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScan {
    pub files: Vec<LocalFile>,
    #[serde(default)]
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalStat {
    pub size: u64,
    #[serde(deserialize_with = "ms")]
    pub mtime: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteStat {
    #[serde(with = "crate::u64_str")]
    pub id: u64,
    #[serde(with = "crate::u64_str")]
    pub hash: u64,
    pub size: u64,
    pub modified: i64,
}

impl From<&LocalFile> for LocalStat {
    fn from(f: &LocalFile) -> Self {
        LocalStat {
            size: f.size,
            mtime: f.mtime,
        }
    }
}

impl From<&RemoteFile> for RemoteStat {
    fn from(f: &RemoteFile) -> Self {
        RemoteStat {
            id: f.id,
            hash: f.hash,
            size: f.size,
            modified: f.modified,
        }
    }
}

/// What both sides agreed on after the last successful sync of a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaseEntry {
    pub path: String,
    pub sha1: String,
    pub local: LocalStat,
    pub remote: RemoteStat,
}

/// Keyed by `path::key`.
pub type Baseline = BTreeMap<String, BaseEntry>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "paths", rename_all = "camelCase")]
pub enum Scope {
    #[default]
    Full,
    /// Only these paths are looked at; anything else is left alone.
    Paths(Vec<String>),
}

/// How to treat a file that exists on both sides with no sync history.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirstSync {
    #[default]
    Merge,
    PreferRemote,
    PreferLocal,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanInput {
    pub scope: Scope,
    pub local: LocalScan,
    pub first_sync: FirstSync,
    /// sha1 from `checksumfile`, by remote file id.
    #[serde(deserialize_with = "remote_sha1")]
    pub remote_sha1: HashMap<u64, String>,
    /// Goes into conflict copy names, e.g. `2026-10-19 1432`.
    pub stamp: String,
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// Base update only, no I/O: content is already equal.
    Adopt {
        path: String,
        sha1: String,
        local: LocalStat,
        remote: RemoteStat,
    },
    Forget {
        path: String,
    },
    RenameLocal {
        from: String,
        to: String,
        expect: LocalStat,
    },
    RenameRemote {
        from: String,
        to: String,
        expect: RemoteStat,
    },
    /// `replace`: the remote file we expect to overwrite. Skip if its hash moved.
    /// `remote_path` is set when pCloud spells the name differently (NFC vs NFD).
    Upload {
        path: String,
        #[serde(rename = "remotePath", skip_serializing_if = "Option::is_none")]
        remote_path: Option<String>,
        sha1: Option<String>,
        local: LocalStat,
        replace: Option<RemoteStat>,
    },
    /// `replace`: the local file we expect to overwrite. Skip if it changed.
    Download {
        path: String,
        remote: RemoteStat,
        replace: Option<LocalStat>,
    },
    /// Remote version goes to `copy`, then the local one is uploaded over it.
    Conflict {
        path: String,
        #[serde(rename = "remotePath", skip_serializing_if = "Option::is_none")]
        remote_path: Option<String>,
        copy: String,
        local: LocalStat,
        remote: RemoteStat,
    },
    DeleteLocal {
        path: String,
        expect: LocalStat,
    },
    DeleteRemote {
        path: String,
        expect: RemoteStat,
    },
}

impl Action {
    pub fn path(&self) -> &str {
        match self {
            Action::Adopt { path, .. }
            | Action::Forget { path }
            | Action::Upload { path, .. }
            | Action::Download { path, .. }
            | Action::Conflict { path, .. }
            | Action::DeleteLocal { path, .. }
            | Action::DeleteRemote { path, .. } => path,
            Action::RenameLocal { to, .. } | Action::RenameRemote { to, .. } => to,
        }
    }

    pub(crate) fn order(&self) -> u8 {
        match self {
            Action::Adopt { .. } | Action::Forget { .. } => 0,
            Action::RenameLocal { .. } | Action::RenameRemote { .. } => 1,
            Action::Upload { .. } | Action::Download { .. } | Action::Conflict { .. } => 2,
            Action::DeleteLocal { .. } | Action::DeleteRemote { .. } => 3,
        }
    }

    pub fn is_delete(&self) -> bool {
        matches!(
            self,
            Action::DeleteLocal { .. } | Action::DeleteRemote { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Warning {
    /// Several names fold to the same path (`Note.md` and `note.md`).
    Collision {
        paths: Vec<String>,
    },
    /// A file on one side, a folder on the other.
    TypeConflict {
        path: String,
    },
    Skipped {
        path: String,
        reason: Skip,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Guard {
    FirstSync,
    MassDelete { count: usize },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub actions: Vec<Action>,
    pub warnings: Vec<Warning>,
    /// Ask the user before running this plan.
    pub guard: Option<Guard>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanResult {
    /// Hash these and plan again.
    NeedHashes {
        local: Vec<String>,
        remote: Vec<u64>,
    },
    Ready(Plan),
}

/// JS hands over ms timestamps that may carry a fraction.
fn ms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(f64::deserialize(d)?.trunc() as i64)
}

fn remote_sha1<'de, D: serde::Deserializer<'de>>(d: D) -> Result<HashMap<u64, String>, D::Error> {
    let raw = HashMap::<String, String>::deserialize(d)?;
    raw.into_iter()
        .map(|(k, v)| k.parse().map(|k| (k, v)).map_err(serde::de::Error::custom))
        .collect()
}
