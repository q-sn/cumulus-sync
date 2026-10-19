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
        // Obsidian doesn't show dot files, so they can't be synced through it.
        if key.split('/').any(|part| part.starts_with('.')) {
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
/// without `/` matches a file or folder name at any depth, like .gitignore.
pub fn glob(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches('/').trim_end_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    if !pattern.contains('/') {
        return parts.iter().any(|part| segment(pattern, part));
    }
    let pat: Vec<&str> = pattern.split('/').collect();
    glob_parts(&pat, &parts)
}

fn glob_parts(pat: &[&str], parts: &[&str]) -> bool {
    match pat.split_first() {
        None => parts.is_empty(),
        Some((&"**", rest)) => {
            let rest = skip_stars(rest);
            rest.is_empty() || (0..=parts.len()).any(|i| glob_parts(rest, &parts[i..]))
        }
        Some((first, rest)) => match parts.split_first() {
            Some((part, tail)) => segment(first, part) && glob_parts(rest, tail),
            None => false,
        },
    }
}

fn skip_stars<'a, 'b>(mut pat: &'a [&'b str]) -> &'a [&'b str] {
    while pat.first() == Some(&"**") {
        pat = &pat[1..];
    }
    pat
}

/// Wildcard match within one segment, linear time (no backtracking blowup).
fn segment(pattern: &str, s: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = s.chars().collect();
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, si));
            pi += 1;
        } else if let Some((sp, ss)) = star {
            pi = sp + 1;
            si = ss + 1;
            star = Some((sp, ss + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
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
        assert!(glob("Private", "Private/x.md"));
        assert!(glob("private", "a/private/x.md"));
        assert!(glob("a/**/**/b", "a/b"));
        let long = "a".repeat(60);
        assert!(!glob("*a*a*a*a*a*a*a*a*b", &long));
    }

    #[test]
    fn builtin_and_config_dir() {
        let f = filter(&[]);
        assert_eq!(
            f.skip_path(".obsidian/plugins/cumulus-sync/state.json"),
            Some(Skip::Builtin)
        );
        assert_eq!(f.skip_path(".Obsidian/app.json"), Some(Skip::Builtin));
        assert_eq!(f.skip_path(".trash/old.md"), Some(Skip::Builtin));
        assert_eq!(f.skip_path("photos/Thumbs.db"), Some(Skip::Builtin));
        assert_eq!(f.skip_path(".github/workflows/ci.yml"), Some(Skip::Builtin));
        assert_eq!(f.skip_path("notes/.hidden.md"), Some(Skip::Builtin));
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
