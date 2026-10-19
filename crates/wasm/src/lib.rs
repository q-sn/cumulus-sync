//! wasm bindings. Everything goes out as JSON, u64 as strings.

use cumulus_core::pcloud::{self, ApiError, DiffEvent, ErrorClass, Metadata};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    cumulus_core::VERSION.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError {
    code: u32,
    message: String,
    class: &'static str,
    retryable: bool,
}

impl From<&ApiError> for WireError {
    fn from(e: &ApiError) -> Self {
        WireError {
            code: e.code,
            message: e.message.clone(),
            class: match e.class() {
                ErrorClass::Client => "client",
                ErrorClass::Retry => "retry",
                ErrorClass::Invalid => "invalid",
                ErrorClass::Auth => "auth",
                ErrorClass::RateLimit => "rateLimit",
                ErrorClass::Temporary => "temporary",
                ErrorClass::Other => "other",
            },
            retryable: e.is_retryable(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireMetadata {
    is_folder: bool,
    id: String,
    parent: Option<String>,
    name: String,
    size: u64,
    modified: i64,
    hash: Option<String>,
    is_deleted: bool,
    deleted_file_id: Option<String>,
    contents: Option<Vec<WireMetadata>>,
}

impl From<Metadata> for WireMetadata {
    fn from(m: Metadata) -> Self {
        WireMetadata {
            is_folder: m.is_folder,
            id: m.id.to_string(),
            parent: m.parent.map(|p| p.to_string()),
            name: m.name,
            size: m.size,
            modified: m.modified,
            hash: m.hash.map(|h| h.to_string()),
            is_deleted: m.is_deleted,
            deleted_file_id: m.deleted_file_id.map(|d| d.to_string()),
            contents: m.contents.map(|c| c.into_iter().map(Into::into).collect()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDiffEntry {
    diffid: String,
    event: String,
    metadata: Option<WireMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDiffPage {
    diffid: String,
    entries: Vec<WireDiffEntry>,
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("wire types always serialize")
}

fn wire<T: Serialize>(result: Result<T, ApiError>) -> Result<String, JsError> {
    result
        .map(|v| to_json(&v))
        .map_err(|e| JsError::new(&to_json(&WireError::from(&e))))
}

#[wasm_bindgen(js_name = pcloudError)]
pub fn pcloud_error(body: &str) -> Option<String> {
    pcloud::check(body)
        .err()
        .map(|e| to_json(&WireError::from(&e)))
}

#[wasm_bindgen(js_name = pcloudMetadata)]
pub fn pcloud_metadata(body: &str) -> Result<String, JsError> {
    wire(pcloud::parse_metadata(body).map(WireMetadata::from))
}

#[wasm_bindgen(js_name = pcloudUpload)]
pub fn pcloud_upload(body: &str) -> Result<String, JsError> {
    wire(pcloud::parse_upload(body).map(WireMetadata::from))
}

#[derive(Serialize)]
struct WireChecksum {
    sha1: String,
    metadata: WireMetadata,
}

#[wasm_bindgen(js_name = pcloudChecksum)]
pub fn pcloud_checksum(body: &str) -> Result<String, JsError> {
    wire(pcloud::parse_checksum(body).map(|c| WireChecksum {
        sha1: c.sha1,
        metadata: c.metadata.into(),
    }))
}

#[wasm_bindgen(js_name = pcloudDiff)]
pub fn pcloud_diff(body: &str) -> Result<String, JsError> {
    wire(pcloud::parse_diff(body).map(|page| {
        WireDiffPage {
            diffid: page.diffid.to_string(),
            entries: page
                .entries
                .into_iter()
                .map(|e| {
                    let (event, metadata) = match e.event {
                        DiffEvent::Reset => ("reset".to_string(), None),
                        DiffEvent::CreateFolder(m) => ("createfolder".into(), Some(m)),
                        DiffEvent::ModifyFolder(m) => ("modifyfolder".into(), Some(m)),
                        DiffEvent::DeleteFolder(m) => ("deletefolder".into(), Some(m)),
                        DiffEvent::CreateFile(m) => ("createfile".into(), Some(m)),
                        DiffEvent::ModifyFile(m) => ("modifyfile".into(), Some(m)),
                        DiffEvent::DeleteFile(m) => ("deletefile".into(), Some(m)),
                        DiffEvent::Other(name) => (name, None),
                    };
                    WireDiffEntry {
                        diffid: e.diffid.to_string(),
                        event,
                        metadata: metadata.map(Into::into),
                    }
                })
                .collect(),
        }
    }))
}
