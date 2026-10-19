//! u64 as a decimal string in JSON, so values survive a trip through JS.

use serde::{de, Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.collect_str(v)
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Str(String),
        Num(u64),
    }
    match Either::deserialize(d)? {
        Either::Str(s) => s.parse().map_err(de::Error::custom),
        Either::Num(n) => Ok(n),
    }
}
