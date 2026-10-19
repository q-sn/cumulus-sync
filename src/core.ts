import init, * as wasm from "../crates/wasm/pkg/cumulus_wasm.js";
import wasmBytes from "../crates/wasm/pkg/cumulus_wasm_bg.wasm";

let ready: Promise<void> | null = null;

export function loadCore(): Promise<void> {
	ready ??= init({ module_or_path: wasmBytes }).then(() => undefined);
	return ready;
}

export const Engine = wasm.Engine;
export type Engine = wasm.Engine;
export const coreVersion = wasm.coreVersion;
export const pcloudError = wasm.pcloudError;
export const pcloudMetadata = wasm.pcloudMetadata;
export const pcloudUpload = wasm.pcloudUpload;
export const pcloudChecksum = wasm.pcloudChecksum;
export const pcloudDiff = wasm.pcloudDiff;
