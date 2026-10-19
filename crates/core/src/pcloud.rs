//! pCloud API responses. Requests must use `timeformat=timestamp`.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: u32,
    pub message: String,
}

// https://docs.pcloud.com/errors/
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Client,
    Retry,
    Invalid,
    Auth,
    RateLimit,
    Temporary,
    Other,
}

pub const MALFORMED: u32 = 0;

impl ApiError {
    pub fn class(&self) -> ErrorClass {
        match self.code {
            1000 | 2000 | 2094 | 2095 => ErrorClass::Auth,
            1900..=1999 => ErrorClass::Retry,
            1000..=1999 => ErrorClass::Client,
            2000..=2999 => ErrorClass::Invalid,
            4000..=4999 => ErrorClass::RateLimit,
            5000..=5999 => ErrorClass::Temporary,
            _ => ErrorClass::Other,
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self.class(),
            ErrorClass::Retry | ErrorClass::RateLimit | ErrorClass::Temporary
        )
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self.code, 2002 | 2005 | 2009)
    }

    fn malformed(detail: impl std::fmt::Display) -> Self {
        ApiError {
            code: MALFORMED,
            message: format!("malformed pCloud response: {detail}"),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pCloud error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub is_folder: bool,
    // fileid or folderid, these overlap
    pub id: u64,
    pub parent: Option<u64>,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub hash: Option<u64>,
    pub is_deleted: bool,
    pub deleted_file_id: Option<u64>,
    pub contents: Option<Vec<Metadata>>,
}

#[derive(Deserialize)]
struct RawMetadata {
    #[serde(default)]
    isfolder: bool,
    fileid: Option<u64>,
    folderid: Option<u64>,
    parentfolderid: Option<u64>,
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: i64,
    hash: Option<u64>,
    #[serde(default)]
    isdeleted: bool,
    deletedfileid: Option<u64>,
    contents: Option<Vec<RawMetadata>>,
}

impl TryFrom<RawMetadata> for Metadata {
    type Error = ApiError;

    fn try_from(raw: RawMetadata) -> Result<Self, ApiError> {
        let id = if raw.isfolder {
            raw.folderid
        } else {
            raw.fileid
        }
        .ok_or_else(|| ApiError::malformed(format!("no id for {:?}", raw.name)))?;
        let contents = raw
            .contents
            .map(|c| c.into_iter().map(Metadata::try_from).collect())
            .transpose()?;
        Ok(Metadata {
            is_folder: raw.isfolder,
            id,
            parent: raw.parentfolderid,
            name: raw.name,
            size: raw.size,
            modified: raw.modified,
            hash: if raw.isfolder { None } else { raw.hash },
            is_deleted: raw.isdeleted,
            deleted_file_id: raw.deletedfileid,
            contents,
        })
    }
}

#[derive(Deserialize)]
struct Envelope {
    result: u32,
    error: Option<String>,
}

pub fn check(body: &str) -> Result<(), ApiError> {
    let env: Envelope = serde_json::from_str(body).map_err(ApiError::malformed)?;
    if env.result == 0 {
        Ok(())
    } else {
        Err(ApiError {
            code: env.result,
            message: env.error.unwrap_or_default(),
        })
    }
}

fn parse<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T, ApiError> {
    check(body)?;
    serde_json::from_str(body).map_err(ApiError::malformed)
}

#[derive(Deserialize)]
struct WithMetadata {
    metadata: RawMetadata,
}

pub fn parse_metadata(body: &str) -> Result<Metadata, ApiError> {
    parse::<WithMetadata>(body)?.metadata.try_into()
}

#[derive(Deserialize)]
struct UploadResponse {
    metadata: Vec<RawMetadata>,
}

// uploadfile returns a list, we upload one file at a time
pub fn parse_upload(body: &str) -> Result<Metadata, ApiError> {
    parse::<UploadResponse>(body)?
        .metadata
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::malformed("upload returned no metadata"))?
        .try_into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checksum {
    pub sha1: String,
    pub metadata: Metadata,
}

#[derive(Deserialize)]
struct RawChecksum {
    sha1: String,
    metadata: RawMetadata,
}

pub fn parse_checksum(body: &str) -> Result<Checksum, ApiError> {
    let raw: RawChecksum = parse(body)?;
    Ok(Checksum {
        sha1: raw.sha1.to_ascii_lowercase(),
        metadata: raw.metadata.try_into()?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffEvent {
    Reset,
    CreateFolder(Metadata),
    ModifyFolder(Metadata),
    DeleteFolder(Metadata),
    CreateFile(Metadata),
    ModifyFile(Metadata),
    DeleteFile(Metadata),
    // shares, userinfo etc.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffEntry {
    pub diffid: u64,
    pub event: DiffEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffPage {
    pub diffid: u64,
    pub entries: Vec<DiffEntry>,
}

#[derive(Deserialize)]
struct RawDiff {
    diffid: u64,
    #[serde(default)]
    entries: Vec<RawDiffEntry>,
}

#[derive(Deserialize)]
struct RawDiffEntry {
    diffid: u64,
    event: String,
    metadata: Option<RawMetadata>,
}

pub fn parse_diff(body: &str) -> Result<DiffPage, ApiError> {
    let raw: RawDiff = parse(body)?;
    let entries = raw
        .entries
        .into_iter()
        .map(|e| {
            let meta = |m: Option<RawMetadata>| -> Result<Metadata, ApiError> {
                m.ok_or_else(|| ApiError::malformed(format!("{} without metadata", e.event)))?
                    .try_into()
            };
            let event = match e.event.as_str() {
                "reset" => DiffEvent::Reset,
                "createfolder" => DiffEvent::CreateFolder(meta(e.metadata)?),
                "modifyfolder" => DiffEvent::ModifyFolder(meta(e.metadata)?),
                "deletefolder" => DiffEvent::DeleteFolder(meta(e.metadata)?),
                "createfile" => DiffEvent::CreateFile(meta(e.metadata)?),
                "modifyfile" => DiffEvent::ModifyFile(meta(e.metadata)?),
                "deletefile" => DiffEvent::DeleteFile(meta(e.metadata)?),
                _ => DiffEvent::Other(e.event.clone()),
            };
            Ok(DiffEntry {
                diffid: e.diffid,
                event,
            })
        })
        .collect::<Result<_, ApiError>>()?;
    Ok(DiffPage {
        diffid: raw.diffid,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // > 2^53
    const BIG_HASH: u64 = 18_014_398_509_481_985;

    #[test]
    fn error_envelope() {
        let err = check(r#"{"result":2005,"error":"Directory does not exist."}"#).unwrap_err();
        assert_eq!(err.code, 2005);
        assert!(err.is_not_found());
        assert_eq!(err.class(), ErrorClass::Invalid);
        assert!(!err.is_retryable());
    }

    #[test]
    fn error_classes() {
        let class = |code| {
            ApiError {
                code,
                message: String::new(),
            }
            .class()
        };
        assert_eq!(class(2094), ErrorClass::Auth);
        assert_eq!(class(1000), ErrorClass::Auth);
        assert_eq!(class(1004), ErrorClass::Client);
        assert_eq!(class(1900), ErrorClass::Retry);
        assert_eq!(class(4000), ErrorClass::RateLimit);
        assert_eq!(class(5000), ErrorClass::Temporary);
    }

    #[test]
    fn malformed_body() {
        let err = check("<html>404</html>").unwrap_err();
        assert_eq!(err.code, MALFORMED);
    }

    #[test]
    fn recursive_listing_keeps_big_hash() {
        let body = format!(
            r#"{{"result":0,"metadata":{{"isfolder":true,"folderid":42,"parentfolderid":0,
            "name":"Vault","modified":1729300000,"contents":[
              {{"isfolder":false,"fileid":7,"parentfolderid":42,"name":"Note.md",
                "size":12,"modified":1729300001,"hash":{BIG_HASH},"contenttype":"text/markdown"}},
              {{"isfolder":true,"folderid":43,"parentfolderid":42,"name":"Sub","modified":1,"contents":[]}}
            ]}}}}"#
        );
        let root = parse_metadata(&body).unwrap();
        assert!(root.is_folder);
        assert_eq!(root.id, 42);
        let contents = root.contents.unwrap();
        assert_eq!(contents[0].hash, Some(BIG_HASH));
        assert_eq!(contents[0].parent, Some(42));
        assert!(contents[1].is_folder);
        assert_eq!(contents[1].contents.as_deref(), Some(&[][..]));
    }

    #[test]
    fn upload_response() {
        let body = r#"{"result":0,"fileids":[9],"metadata":[{"isfolder":false,"fileid":9,
            "parentfolderid":42,"name":"a.md","size":0,"modified":5,"hash":1}]}"#;
        let m = parse_upload(body).unwrap();
        assert_eq!((m.id, m.size, m.hash), (9, 0, Some(1)));
    }

    #[test]
    fn checksum_lowercases_sha1() {
        let body = r#"{"result":0,"sha1":"ABCDEF","metadata":{"isfolder":false,"fileid":9,
            "parentfolderid":42,"name":"a.md","size":3,"modified":5,"hash":1}}"#;
        assert_eq!(parse_checksum(body).unwrap().sha1, "abcdef");
    }

    #[test]
    fn diff_page() {
        let body = format!(
            r#"{{"result":0,"diffid":120,"entries":[
              {{"diffid":100,"time":1,"event":"reset"}},
              {{"diffid":110,"time":2,"event":"modifyfile","metadata":{{"isfolder":false,"fileid":7,
                "parentfolderid":42,"name":"Note.md","size":1,"modified":3,"hash":{BIG_HASH},"deletedfileid":6}}}},
              {{"diffid":115,"time":3,"event":"acceptedshare","share":{{}}}},
              {{"diffid":120,"time":4,"event":"deletefolder","metadata":{{"isfolder":true,"folderid":43,
                "parentfolderid":42,"name":"Sub","modified":3,"isdeleted":true}}}}
            ]}}"#
        );
        let page = parse_diff(&body).unwrap();
        assert_eq!(page.diffid, 120);
        assert_eq!(page.entries[0].event, DiffEvent::Reset);
        match &page.entries[1].event {
            DiffEvent::ModifyFile(m) => {
                assert_eq!(m.hash, Some(BIG_HASH));
                assert_eq!(m.deleted_file_id, Some(6));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            page.entries[2].event,
            DiffEvent::Other("acceptedshare".into())
        );
        match &page.entries[3].event {
            DiffEvent::DeleteFolder(m) => assert!(m.is_deleted && m.is_folder),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn empty_diff_bootstrap() {
        let page = parse_diff(r#"{"result":0,"diffid":555}"#).unwrap();
        assert_eq!(page.diffid, 555);
        assert!(page.entries.is_empty());
    }
}
