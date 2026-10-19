use unicode_normalization::UnicodeNormalization;

/// Vault-relative path with `/` separators, no leading or trailing slash, NFC.
pub fn normalize(path: &str) -> String {
    let joined = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    joined.nfc().collect()
}

/// Identity of a path for matching across devices. Android storage is
/// case-insensitive and macOS hands out NFD names, so both are folded away.
pub fn key(path: &str) -> String {
    normalize(path).to_lowercase()
}

pub fn parent(path: &str) -> Option<&str> {
    path.rfind('/').map(|i| &path[..i])
}

pub fn file_name(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Characters Windows or Android refuse in file names.
pub fn invalid_name(name: &str) -> bool {
    name.chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*') || c < ' ')
        || name.ends_with(' ')
        || name.ends_with('.')
}

/// `Notes/Idea.md` -> `Notes/Idea (conflict 2026-10-19 1432 pixel).md`
pub fn conflict_copy(path: &str, stamp: &str, device: &str) -> String {
    let name = file_name(path);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let suffix = if device.is_empty() {
        format!("conflict {stamp}")
    } else {
        format!("conflict {stamp} {device}")
    };
    let copy = format!("{stem} ({suffix}){ext}");
    match parent(path) {
        Some(dir) => join(dir, &copy),
        None => copy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_unicode() {
        assert_eq!(normalize("/a\\b//c/"), "a/b/c");
        assert_eq!(normalize("./a/./b"), "a/b");
        assert_eq!(normalize("Cafe\u{301}.md"), "Caf\u{e9}.md");
    }

    #[test]
    fn key_folds_case_and_form() {
        assert_eq!(key("Notes/Café.md"), key("notes/CAFE\u{301}.MD"));
        assert_ne!(key("a.md"), key("b.md"));
    }

    #[test]
    fn path_parts() {
        assert_eq!(parent("a/b/c.md"), Some("a/b"));
        assert_eq!(parent("c.md"), None);
        assert_eq!(file_name("a/b/c.md"), "c.md");
        assert_eq!(join("", "x"), "x");
        assert_eq!(join("a", "x"), "a/x");
    }

    #[test]
    fn invalid_names() {
        assert!(invalid_name("a:b.md"));
        assert!(invalid_name("what?.md"));
        assert!(invalid_name("trailing."));
        assert!(!invalid_name("Привет, мир.md"));
    }

    #[test]
    fn conflict_names() {
        assert_eq!(
            conflict_copy("Notes/Idea.md", "2026-10-19 1432", "pixel"),
            "Notes/Idea (conflict 2026-10-19 1432 pixel).md"
        );
        assert_eq!(conflict_copy("README", "x", ""), "README (conflict x)");
        assert_eq!(conflict_copy(".env", "x", ""), ".env (conflict x)");
        assert_eq!(
            conflict_copy("a.tar.gz", "x", "d"),
            "a.tar (conflict x d).gz"
        );
    }
}
