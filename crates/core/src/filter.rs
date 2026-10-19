use serde::{Deserialize, Serialize};

use crate::path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterConfig {
    /// Usually `.obsidian`, but users can rename it.
    pub config_dir: String,
    /// Globs from settings, matched against vault-relative paths.
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub max_file_size: Option<u64>,
}

impl Default for FilterConfig {
    fn default() -> Self {
        FilterConfig {
            config_dir: ".obsidian".into(),
            exclude: Vec::new(),
            max_file_size: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Skip {
    /// Never synced, whatever the settings say.
    Builtin,
    /// Matches a user exclude glob.
    Excluded,
    InvalidName,
    TooLarge,
}

const BUILTIN: &[&str] = &[
    ".trash/**",
    ".git/**",
    "**/.DS_Store",
    "**/desktop.ini",
    "**/Thumbs.db",
    "**/*.tmp",
    "**/~$*",
];

pub struct Filter {
    config_dir_key: String,
    builtin: Vec<String>,
    exclude: Vec<String>,
    max_file_size: Option<u64>,
}

impl Filter {
    pub fn new(config: &FilterConfig) -> Self {
        Filter {
            config_dir_key: path::key(&config.config_dir),
            builtin: BUILTIN.iter().map(|g| g.to_lowercase()).collect(),
            exclude: config.exclude.iter().map(|g| path::key(g)).collect(),
            max_file_size: config.max_file_size,
        }
    }

    /// Path-based rules only; these make a path invisible to sync on both sides.
    pub fn skip_path(&self, p: &str) -> Option<Skip> {
        let key = path::key(p);
        // The whole config dir is out for now, including our own state.
        if key == self.config_dir_key || key.starts_with(&format!("{}/", self.config_dir_key)) {
            return Some(Skip::Builtin);
        }
        if self.builtin.iter().any(|g| glob(g, &key)) {
            return Some(Skip::Builtin);
        }
        if self.exclude.iter().any(|g| glob(g, &key)) {
            return Some(Skip::Excluded);
        }
        if p.split('/').any(path::invalid_name) {
            return Some(Skip::InvalidName);
        }
        None
    }

    pub fn too_large(&self, size: u64) -> bool {
        self.max_file_size.is_some_and(|max| size > max)
    }
}

/// `*` and `?` stay within a path segment, `**` spans segments. A pattern
/// without `/` matches the file name at any depth, like .gitignore.
pub fn glob(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches('/');
    if !pattern.contains('/') {
        return glob_segment(pattern.as_bytes(), path::file_name(path).as_bytes())
            || glob_parts(&["**", pattern], &path.split('/').collect::<Vec<_>>());
    }
    let pat: Vec<&str> = pattern.split('/').collect();
    let parts: Vec<&str> = path.split('/').collect();
    glob_parts(&pat, &parts)
}

fn glob_parts(pat: &[&str], parts: &[&str]) -> bool {
    match pat.split_first() {
        None => parts.is_empty(),
        Some((&"**", rest)) => (0..=parts.len()).any(|i| glob_parts(rest, &parts[i..])),
        Some((first, rest)) => match parts.split_first() {
            Some((part, tail)) => {
                glob_segment(first.as_bytes(), part.as_bytes()) && glob_parts(rest, tail)
            }
            None => false,
        },
    }
}

fn glob_segment(pat: &[u8], s: &[u8]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|i| glob_segment(rest, &s[i..])),
        Some((b'?', rest)) => !s.is_empty() && glob_segment(rest, &s[utf8_len(s[0])..]),
        Some((c, rest)) => s.first() == Some(c) && glob_segment(rest, &s[1..]),
    }
}

fn utf8_len(first: u8) -> usize {
    match first {
        0xF0..=0xFF => 4,
        0xE0..=0xEF => 3,
        0xC0..=0xDF => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(exclude: &[&str]) -> Filter {
        Filter::new(&FilterConfig {
            config_dir: ".obsidian".into(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
            max_file_size: Some(100),
        })
    }

    #[test]
    fn globs() {
        assert!(glob("*.md", "a/b/c.md"));
        assert!(glob("*.md", "c.md"));
        assert!(!glob("*.md", "c.md.bak"));
        assert!(glob("attachments/**", "attachments/x/y.png"));
        assert!(glob("attachments/**", "attachments"));
        assert!(!glob("attachments/**", "notes/attachments/y.png"));
        assert!(glob("**/drafts/*", "a/drafts/x.md"));
        assert!(!glob("**/drafts/*", "a/drafts/b/x.md"));
        assert!(glob("n?te.md", "nöte.md"));
        assert!(glob("Thumbs.db", "deep/Thumbs.db"));
    }

    #[test]
    fn builtin_and_config_dir() {
        let f = filter(&[]);
        assert_eq!(f.skip_path(".obsidian/plugins/cumulus-sync/state.json"), Some(Skip::Builtin));
        assert_eq!(f.skip_path(".Obsidian/app.json"), Some(Skip::Builtin));
        assert_eq!(f.skip_path(".trash/old.md"), Some(Skip::Builtin));
        assert_eq!(f.skip_path("photos/Thumbs.db"), Some(Skip::Builtin));
        assert_eq!(f.skip_path(".obsidian-notes/a.md"), None);
        assert_eq!(f.skip_path("Notes/a.md"), None);
    }

    #[test]
    fn user_excludes_are_case_insensitive() {
        let f = filter(&["Private/**", "*.mp4"]);
        assert_eq!(f.skip_path("private/diary.md"), Some(Skip::Excluded));
        assert_eq!(f.skip_path("Videos/clip.MP4"), Some(Skip::Excluded));
        assert_eq!(f.skip_path("Public/a.md"), None);
    }

    #[test]
    fn invalid_names_and_size() {
        let f = filter(&[]);
        assert_eq!(f.skip_path("a/b:c.md"), Some(Skip::InvalidName));
        assert!(f.too_large(101));
        assert!(!f.too_large(100));
    }
}
