/* tslint:disable */
/* eslint-disable */

export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    applyDiff(body: string): string;
    baseSize(): number;
    commitAdopt(path: string, sha1: string, local: string, remote: string): string;
    commitDownload(path: string, sha1: string, local: string, remote: string): string;
    commitRemoved(path: string, remote_id?: string | null): string;
    commitRenameLocal(from: string, to: string, local: string): string | undefined;
    commitRenameRemote(from: string, to: string, body: string): string | undefined;
    commitUpload(path: string, sha1: string, local: string, body: string): string;
    cursor(): string | undefined;
    hasRemote(): boolean;
    /**
     * Throws `otherDevice`, `unsupported` or `corrupt: ...`.
     */
    static load(device_id: string, snapshot?: string | null, journal?: string | null): Engine;
    mergeListing(body: string): void;
    constructor(device_id: string);
    noteFolder(body: string): void;
    /**
     * Folder ids to list (recursively) and pass to `mergeListing` before planning.
     */
    pendingListings(): string[];
    plan(input: string): string;
    remoteFolder(dir: string): string | undefined;
    remoteRoot(): string | undefined;
    /**
     * Returns journal lines as a JSON array.
     */
    resetRemote(listing: string, cursor: string): string;
    seq(): number;
    setFilter(config: string): void;
    snapshot(): string;
}

export function coreVersion(): string;

export function pcloudChecksum(body: string): string;

export function pcloudDiff(body: string): string;

export function pcloudError(body: string): string | undefined;

export function pcloudMetadata(body: string): string;

export function pcloudUpload(body: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly coreVersion: (a: number) => void;
    readonly engine_applyDiff: (a: number, b: number, c: number, d: number) => void;
    readonly engine_baseSize: (a: number) => number;
    readonly engine_commitAdopt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly engine_commitDownload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly engine_commitRemoved: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_commitRenameLocal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly engine_commitRenameRemote: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly engine_commitUpload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly engine_cursor: (a: number, b: number) => void;
    readonly engine_hasRemote: (a: number) => number;
    readonly engine_load: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_mergeListing: (a: number, b: number, c: number, d: number) => void;
    readonly engine_new: (a: number, b: number) => number;
    readonly engine_noteFolder: (a: number, b: number, c: number, d: number) => void;
    readonly engine_pendingListings: (a: number, b: number) => void;
    readonly engine_plan: (a: number, b: number, c: number, d: number) => void;
    readonly engine_remoteFolder: (a: number, b: number, c: number, d: number) => void;
    readonly engine_remoteRoot: (a: number, b: number) => void;
    readonly engine_resetRemote: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_seq: (a: number) => number;
    readonly engine_setFilter: (a: number, b: number, c: number, d: number) => void;
    readonly engine_snapshot: (a: number, b: number) => void;
    readonly pcloudChecksum: (a: number, b: number, c: number) => void;
    readonly pcloudDiff: (a: number, b: number, c: number) => void;
    readonly pcloudError: (a: number, b: number, c: number) => void;
    readonly pcloudMetadata: (a: number, b: number, c: number) => void;
    readonly pcloudUpload: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
