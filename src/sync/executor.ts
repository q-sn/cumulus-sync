import { type Engine, pcloudMetadata } from "../core";
import type { PCloudClient } from "../pcloud/client";
import { PCloudError, type RemoteMetadata } from "../pcloud/types";
import { type LocalVault, nameOf, parentOf, sha1 } from "./local";
import type { StateStore } from "./state";
import type { Action, LocalStat, RemoteStat } from "./types";

export interface ExecResult {
	done: number;
	skipped: { path: string; reason: string }[];
	failed: { path: string; error: string }[];
	conflicts: string[];
}

/** The world moved between planning and doing; leave it for the next sync. */
class Skip extends Error {}

const sameLocal = (a: LocalStat | null, b: LocalStat) => !!a && a.size === b.size && a.mtime === b.mtime;

export class Executor {
	constructor(
		private readonly engine: Engine,
		private readonly client: PCloudClient,
		private readonly local: LocalVault,
		private readonly store: StateStore,
	) {}

	async run(actions: Action[], onProgress: (done: number, total: number, path: string) => void): Promise<ExecResult> {
		const result: ExecResult = { done: 0, skipped: [], failed: [], conflicts: [] };
		for (const [i, action] of actions.entries()) {
			const path = "path" in action ? action.path : action.to;
			onProgress(i, actions.length, path);
			try {
				await this.exec(action);
				result.done++;
				if (action.kind === "conflict") result.conflicts.push(action.path);
			} catch (e) {
				if (e instanceof Skip) {
					result.skipped.push({ path, reason: e.message });
				} else if (e instanceof PCloudError && (e.errorClass === "auth" || e.code === 2008)) {
					// bad token or over quota: nothing else will work either
					throw e;
				} else {
					result.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
				}
			}
		}
		onProgress(actions.length, actions.length, "");
		return result;
	}

	private async exec(a: Action): Promise<void> {
		switch (a.kind) {
			case "adopt":
				return this.commit(this.engine.commitAdopt(a.path, a.sha1, json(a.local), json(a.remote)));
			case "forget":
				return this.commit(this.engine.commitRemoved(a.path, undefined));
			case "upload":
				return this.upload(a.path, a.local, a.replace);
			case "download":
				return this.download(a.path, a.remote, a.replace);
			case "conflict":
				return this.conflict(a.path, a.copy, a.local, a.remote);
			case "deleteLocal": {
				this.checkLocal(a.path, a.expect);
				await this.local.trash(a.path);
				return this.commit(this.engine.commitRemoved(a.path, undefined));
			}
			case "deleteRemote": {
				const current = await this.remoteStat(a.expect.id);
				if (current && current.hash !== a.expect.hash) throw new Skip("changed remotely");
				if (current) await this.client.deleteFile(a.expect.id).catch(ignoreNotFound);
				return this.commit(this.engine.commitRemoved(a.path, a.expect.id));
			}
			case "renameLocal": {
				this.checkLocal(a.from, a.expect);
				const stat = await this.local.rename(a.from, a.to);
				return this.commit(this.engine.commitRenameLocal(a.from, a.to, json(stat)));
			}
			case "renameRemote": {
				const folder = await this.remoteDir(parentOf(a.to));
				const body = await this.client.renameFileRaw(a.expect.id, folder, nameOf(a.to));
				return this.commit(this.engine.commitRenameRemote(a.from, a.to, body));
			}
		}
	}

	private async upload(path: string, expect: LocalStat, replace: RemoteStat | null): Promise<void> {
		this.checkLocal(path, expect);
		if (replace) {
			const current = await this.remoteStat(replace.id);
			if (!current) throw new Skip("deleted remotely");
			if (current.hash !== replace.hash) throw new Skip("changed remotely");
		}
		const { data, sha1: hash, stat } = await this.local.read(path);
		if (!sameLocal(stat, expect)) throw new Skip("changed locally");
		const folder = await this.remoteDir(parentOf(path));
		const body = await this.client.uploadRaw(folder, nameOf(path), data, Math.floor(stat.mtime / 1000));
		this.commit(this.engine.commitUpload(path, hash, json(stat), body));
	}

	private async download(path: string, remote: RemoteStat, replace: LocalStat | null): Promise<void> {
		const check = () => {
			if (replace) this.checkLocal(path, replace);
			else if (this.local.file(path)) throw new Skip("appeared locally");
		};
		check();
		const data = await this.client.download(remote.id);
		const hash = await sha1(data);
		check();
		const stat = await this.local.write(path, data, remote.modified * 1000, hash);
		this.commit(this.engine.commitDownload(path, hash, json(stat), json(remote)));
	}

	private async conflict(path: string, copy: string, local: LocalStat, remote: RemoteStat): Promise<void> {
		this.checkLocal(path, local);
		const current = await this.remoteStat(remote.id);
		if (!current || current.hash !== remote.hash) throw new Skip("changed remotely");
		const theirs = await this.client.download(remote.id);
		// The copy is a new local file; the next sync uploads it like any other.
		await this.local.write(this.local.freePath(copy), theirs, remote.modified * 1000, await sha1(theirs));
		await this.upload(path, local, remote);
	}

	private checkLocal(path: string, expect: LocalStat): void {
		if (this.local.hasUnsavedEdits(path)) throw new Skip("being edited");
		if (!sameLocal(this.local.stat(path), expect)) throw new Skip("changed locally");
	}

	private async remoteStat(id: string): Promise<RemoteMetadata | null> {
		try {
			return await this.client.statFile(id);
		} catch (e) {
			if (e instanceof PCloudError && e.isNotFound) return null;
			throw e;
		}
	}

	private async remoteDir(dir: string): Promise<string> {
		const known = this.engine.remoteFolder(dir);
		if (known) return known;
		if (!dir) throw new Error("remote vault folder is not set");
		const parent = await this.remoteDir(parentOf(dir));
		const body = await this.client.createFolderRaw(parent, nameOf(dir));
		this.engine.noteFolder(body);
		return (JSON.parse(pcloudMetadata(body)) as RemoteMetadata).id;
	}

	private commit(line: string | undefined): Promise<void> {
		return line ? this.store.append(line) : Promise.resolve();
	}
}

function json(v: unknown): string {
	return JSON.stringify(v);
}

function ignoreNotFound(e: unknown): void {
	if (!(e instanceof PCloudError && e.isNotFound)) throw e;
}
