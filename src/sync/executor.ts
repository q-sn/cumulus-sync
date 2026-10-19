import { type Engine, pcloudMetadata, pcloudUpload } from "../core";
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

export class Cancelled extends Error {}

const sameLocal = (a: LocalStat | null, b: LocalStat) => !!a && a.size === b.size && a.mtime === b.mtime;

export class Executor {
	/** Names in remote folders, loaded once per run to spot files that appeared since the listing. */
	private remoteNames = new Map<string, Promise<Set<string>>>();

	constructor(
		private readonly engine: Engine,
		private readonly client: PCloudClient,
		private readonly local: LocalVault,
		private readonly store: StateStore,
		private readonly stopped: () => boolean,
	) {}

	async run(actions: Action[], onProgress: (done: number, total: number, path: string) => void): Promise<ExecResult> {
		const result: ExecResult = { done: 0, skipped: [], failed: [], conflicts: [] };
		for (const [i, action] of actions.entries()) {
			if (this.stopped()) throw new Cancelled("stopped");
			const path = "path" in action ? action.path : action.to;
			onProgress(i, actions.length, path);
			try {
				await this.exec(action);
				result.done++;
				if (action.kind === "conflict") result.conflicts.push(action.path);
			} catch (e) {
				if (e instanceof Skip) {
					result.skipped.push({ path, reason: e.message });
				} else if (e instanceof PCloudError && fatal(e)) {
					// offline, rate limited, bad token or full: the rest would fail the same way
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
				return this.upload(a.path, a.remotePath ?? a.path, a.local, a.replace);
			case "download":
				return this.download(a.path, a.remote, a.replace);
			case "conflict":
				return this.conflict(a.path, a.remotePath ?? a.path, a.copy, a.local, a.remote);
			case "deleteLocal": {
				this.checkLocal(a.path, a.expect);
				await this.local.trash(a.path);
				return this.commit(this.engine.commitRemoved(a.path, undefined));
			}
			case "deleteRemote": {
				const current = await this.remoteStat(a.expect.id);
				if (current) {
					this.checkRemote(current, a.path, a.expect);
					await this.client.deleteFile(a.expect.id).catch(ignoreNotFound);
				}
				return this.commit(this.engine.commitRemoved(a.path, a.expect.id));
			}
			case "renameLocal": {
				this.checkLocal(a.from, a.expect);
				const stat = await this.local.rename(a.from, a.to);
				return this.commit(this.engine.commitRenameLocal(a.from, a.to, json(stat)));
			}
			case "renameRemote": {
				const current = await this.remoteStat(a.expect.id);
				if (!current) throw new Skip("deleted remotely");
				this.checkRemote(current, a.from, a.expect);
				const folder = await this.remoteDir(parentOf(a.to));
				const body = await this.client.renameFileRaw(a.expect.id, folder, nameOf(a.to));
				return this.commit(this.engine.commitRenameRemote(a.from, a.to, body));
			}
		}
	}

	private async upload(path: string, remotePath: string, expect: LocalStat, replace: RemoteStat | null): Promise<void> {
		this.checkLocal(path, expect);
		const folder = await this.remoteDir(parentOf(remotePath));
		const name = nameOf(remotePath);
		if (replace) {
			const current = await this.remoteStat(replace.id);
			if (!current) throw new Skip("deleted remotely");
			this.checkRemote(current, remotePath, replace);
		} else if ((await this.namesIn(folder)).has(name)) {
			// someone else created the same file since we looked; compare them next time
			throw new Skip("appeared remotely");
		}
		const { data, sha1: hash, stat } = await this.local.read(path);
		if (!sameLocal(stat, expect)) throw new Skip("changed locally");
		const body = await this.client.uploadRaw(folder, name, data, Math.floor(stat.mtime / 1000), {
			renameIfExists: !replace,
		});
		const uploaded = JSON.parse(pcloudUpload(body)) as RemoteMetadata;
		if (uploaded.name !== name) {
			// lost a race for the name: pCloud kept both, the next sync sorts them out
			throw new Skip(`appeared remotely, uploaded as ${uploaded.name}`);
		}
		(await this.namesIn(folder)).add(name);
		await this.commit(this.engine.commitUpload(path, hash, json(stat), body));
	}

	private async download(path: string, remote: RemoteStat, replace: LocalStat | null): Promise<void> {
		const check = () => {
			if (replace) this.checkLocal(path, replace);
			else if (this.local.file(path)) throw new Skip("appeared locally");
		};
		check();
		const data = await this.client.download(remote.id, remote.size);
		const hash = await sha1(data);
		check();
		const stat = await this.local.write(path, data, remote.modified * 1000, hash);
		await this.commit(this.engine.commitDownload(path, hash, json(stat), json(remote)));
	}

	private async conflict(
		path: string,
		remotePath: string,
		copy: string,
		local: LocalStat,
		remote: RemoteStat,
	): Promise<void> {
		this.checkLocal(path, local);
		const current = await this.remoteStat(remote.id);
		if (!current) throw new Skip("deleted remotely");
		this.checkRemote(current, remotePath, remote);
		const theirs = await this.client.download(remote.id, remote.size);
		const theirHash = await sha1(theirs);
		// A retry after a failed upload must not leave a second identical copy.
		if (!(await this.local.hasCopy(path, theirHash))) {
			await this.local.write(this.local.freePath(copy), theirs, remote.modified * 1000, theirHash);
		}
		await this.upload(path, remotePath, local, remote);
	}

	private checkLocal(path: string, expect: LocalStat): void {
		if (this.local.hasUnsavedEdits(path)) throw new Skip("being edited");
		if (!sameLocal(this.local.stat(path), expect)) throw new Skip("changed locally");
	}

	/** The file must still be the one we planned for, at the place we planned for. */
	private checkRemote(current: RemoteMetadata, path: string, expect: RemoteStat): void {
		if (current.hash !== expect.hash) throw new Skip("changed remotely");
		const folder = this.engine.remoteFolder(parentOf(path));
		if (current.parent !== folder || current.name !== nameOf(path)) throw new Skip("moved remotely");
	}

	private async remoteStat(id: string): Promise<RemoteMetadata | null> {
		try {
			return await this.client.statFile(id);
		} catch (e) {
			if (e instanceof PCloudError && e.isNotFound) return null;
			throw e;
		}
	}

	private namesIn(folder: string): Promise<Set<string>> {
		let names = this.remoteNames.get(folder);
		if (!names) {
			names = this.client.listFolder(folder).then((f) => new Set((f.contents ?? []).map((m) => m.name)));
			// don't cache a failure
			names.catch(() => this.remoteNames.delete(folder));
			this.remoteNames.set(folder, names);
		}
		return names;
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

	private async commit(line: string | undefined): Promise<void> {
		if (line) await this.store.append(line);
	}
}

function fatal(e: PCloudError): boolean {
	return e.errorClass === "network" || e.errorClass === "rateLimit" || e.errorClass === "auth" || e.code === 2008;
}

function json(v: unknown): string {
	return JSON.stringify(v);
}

function ignoreNotFound(e: unknown): void {
	if (!(e instanceof PCloudError && e.isNotFound)) throw e;
}
