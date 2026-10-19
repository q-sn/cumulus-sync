// Mirrors the serde output of crates/core/src/model.rs.

export interface LocalStat {
	size: number;
	mtime: number;
}

export interface RemoteStat {
	id: string;
	hash: string;
	size: number;
	modified: number;
}

export interface LocalFile extends LocalStat {
	path: string;
	sha1?: string | null;
}

export type Action =
	| { kind: "adopt"; path: string; sha1: string; local: LocalStat; remote: RemoteStat }
	| { kind: "forget"; path: string }
	| { kind: "renameLocal"; from: string; to: string; expect: LocalStat }
	| { kind: "renameRemote"; from: string; to: string; expect: RemoteStat }
	| { kind: "upload"; path: string; sha1: string | null; local: LocalStat; replace: RemoteStat | null }
	| { kind: "download"; path: string; remote: RemoteStat; replace: LocalStat | null }
	| { kind: "conflict"; path: string; copy: string; local: LocalStat; remote: RemoteStat }
	| { kind: "deleteLocal"; path: string; expect: LocalStat }
	| { kind: "deleteRemote"; path: string; expect: RemoteStat };

export type SkipReason = "builtin" | "excluded" | "invalidName" | "tooLarge";

export type Warning =
	| { kind: "collision"; paths: string[] }
	| { kind: "typeConflict"; path: string }
	| { kind: "skipped"; path: string; reason: SkipReason };

export type Guard = { kind: "firstSync" } | { kind: "massDelete"; count: number };

export interface Plan {
	actions: Action[];
	warnings: Warning[];
	guard: Guard | null;
}

export type PlanResult =
	| { type: "needHashes"; local: string[]; remote: string[] }
	| { type: "ready"; plan: Plan };

export type FirstSync = "merge" | "preferRemote" | "preferLocal";

export type Scope = { type: "full" } | { type: "paths"; paths: string[] };

export interface PlanInput {
	scope: Scope;
	local: { files: LocalFile[]; folders: string[] };
	firstSync: FirstSync;
	remoteSha1: Record<string, string>;
	stamp: string;
	device: string;
}

export interface FilterConfig {
	configDir: string;
	exclude: string[];
	maxFileSize: number | null;
}
