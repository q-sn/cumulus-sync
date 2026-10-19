use cumulus_core::engine::{Engine, LoadError};
use cumulus_core::filter::FilterConfig;
use cumulus_core::model::{LocalStat, PlanInput, PlanResult, RemoteStat};
use cumulus_core::pcloud::ApiError;
use serde::de::DeserializeOwned;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::{api_error, to_json};

#[wasm_bindgen(js_name = Engine)]
pub struct WasmEngine(Engine);

fn parse<T: DeserializeOwned>(what: &str, json: &str) -> Result<T, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("bad {what}: {e}")))
}

fn id(s: &str) -> Result<u64, JsError> {
    s.parse().map_err(|_| JsError::new(&format!("bad id: {s}")))
}

fn api<T>(r: Result<T, ApiError>) -> Result<T, JsError> {
    r.map_err(|e| api_error(&e))
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WirePlan<'a> {
    NeedHashes {
        local: &'a [String],
        remote: Vec<String>,
    },
    Ready {
        plan: &'a cumulus_core::model::Plan,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDiff {
    reset: bool,
    list_folders: Vec<String>,
    caught_up: bool,
}

#[wasm_bindgen(js_class = Engine)]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(device_id: &str) -> WasmEngine {
        WasmEngine(Engine::new(device_id))
    }

    /// Throws `otherDevice`, `unsupported` or `corrupt: ...`.
    pub fn load(
        device_id: &str,
        snapshot: Option<String>,
        journal: Option<String>,
    ) -> Result<WasmEngine, JsError> {
        Engine::load(device_id, snapshot.as_deref(), journal.as_deref())
            .map(WasmEngine)
            .map_err(|e| {
                JsError::new(&match e {
                    LoadError::OtherDevice => "otherDevice".to_string(),
                    LoadError::Unsupported(_) => "unsupported".to_string(),
                    LoadError::Corrupt(msg) => format!("corrupt: {msg}"),
                })
            })
    }

    pub fn snapshot(&self) -> String {
        self.0.snapshot()
    }

    pub fn seq(&self) -> f64 {
        self.0.seq() as f64
    }

    #[wasm_bindgen(js_name = setFilter)]
    pub fn set_filter(&mut self, config: &str) -> Result<(), JsError> {
        self.0.set_filter(parse::<FilterConfig>("filter", config)?);
        Ok(())
    }

    #[wasm_bindgen(js_name = hasRemote)]
    pub fn has_remote(&self) -> bool {
        self.0.has_remote()
    }

    pub fn cursor(&self) -> Option<String> {
        self.0.cursor().map(|c| c.to_string())
    }

    #[wasm_bindgen(js_name = baseSize)]
    pub fn base_size(&self) -> usize {
        self.0.base_len()
    }

    /// Returns journal lines as a JSON array.
    #[wasm_bindgen(js_name = resetRemote)]
    pub fn reset_remote(&mut self, listing: &str, cursor: &str) -> Result<String, JsError> {
        let lines = api(self.0.reset_remote(listing, id(cursor)?))?;
        Ok(to_json(&lines))
    }

    #[wasm_bindgen(js_name = applyDiff)]
    pub fn apply_diff(&mut self, body: &str) -> Result<String, JsError> {
        let out = api(self.0.apply_diff(body))?;
        Ok(to_json(&WireDiff {
            reset: out.reset,
            list_folders: out.list_folders.iter().map(u64::to_string).collect(),
            caught_up: out.caught_up,
        }))
    }

    #[wasm_bindgen(js_name = mergeListing)]
    pub fn merge_listing(&mut self, body: &str) -> Result<(), JsError> {
        api(self.0.merge_listing(body))
    }

    pub fn plan(&self, input: &str) -> Result<String, JsError> {
        let input: PlanInput = parse("plan input", input)?;
        let result = self
            .0
            .plan(&input)
            .ok_or_else(|| JsError::new("no remote state, list the vault folder first"))?;
        Ok(match &result {
            PlanResult::NeedHashes { local, remote } => to_json(&WirePlan::NeedHashes {
                local,
                remote: remote.iter().map(u64::to_string).collect(),
            }),
            PlanResult::Ready(plan) => to_json(&WirePlan::Ready { plan }),
        })
    }

    #[wasm_bindgen(js_name = remoteFolder)]
    pub fn remote_folder(&self, dir: &str) -> Option<String> {
        self.0.remote_folder(dir).map(|id| id.to_string())
    }

    #[wasm_bindgen(js_name = remoteRoot)]
    pub fn remote_root(&self) -> Option<String> {
        self.0.remote_root().map(|id| id.to_string())
    }

    #[wasm_bindgen(js_name = noteFolder)]
    pub fn note_folder(&mut self, body: &str) -> Result<(), JsError> {
        api(self.0.note_folder(body))
    }

    #[wasm_bindgen(js_name = commitUpload)]
    pub fn commit_upload(
        &mut self,
        path: &str,
        sha1: &str,
        local: &str,
        body: &str,
    ) -> Result<String, JsError> {
        let local: LocalStat = parse("local stat", local)?;
        api(self.0.commit_upload(path, sha1, local, body))
    }

    #[wasm_bindgen(js_name = commitDownload)]
    pub fn commit_download(
        &mut self,
        path: &str,
        sha1: &str,
        local: &str,
        remote: &str,
    ) -> Result<String, JsError> {
        let local: LocalStat = parse("local stat", local)?;
        let remote: RemoteStat = parse("remote stat", remote)?;
        Ok(self.0.commit_download(path, sha1, local, remote))
    }

    #[wasm_bindgen(js_name = commitAdopt)]
    pub fn commit_adopt(
        &mut self,
        path: &str,
        sha1: &str,
        local: &str,
        remote: &str,
    ) -> Result<String, JsError> {
        let local: LocalStat = parse("local stat", local)?;
        let remote: RemoteStat = parse("remote stat", remote)?;
        Ok(self.0.commit_adopt(path, sha1, local, remote))
    }

    #[wasm_bindgen(js_name = commitRenameLocal)]
    pub fn commit_rename_local(
        &mut self,
        from: &str,
        to: &str,
        local: &str,
    ) -> Result<Option<String>, JsError> {
        let local: LocalStat = parse("local stat", local)?;
        Ok(self.0.commit_rename_local(from, to, local))
    }

    #[wasm_bindgen(js_name = commitRenameRemote)]
    pub fn commit_rename_remote(
        &mut self,
        from: &str,
        to: &str,
        body: &str,
    ) -> Result<Option<String>, JsError> {
        api(self.0.commit_rename_remote(from, to, body))
    }

    #[wasm_bindgen(js_name = commitRemoved)]
    pub fn commit_removed(
        &mut self,
        path: &str,
        remote_id: Option<String>,
    ) -> Result<String, JsError> {
        let remote_id = remote_id.as_deref().map(id).transpose()?;
        Ok(self.0.commit_removed(path, remote_id))
    }
}
