//! Sync engine. No I/O: the plugin passes in scan results and raw API responses.

pub mod pcloud;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!VERSION.is_empty());
    }
}
