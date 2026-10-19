import { type App, Platform } from "obsidian";
import type { AuthManager } from "../auth";
import type { Engine } from "../core";
import { defaultDeviceName, type Device } from "../device";
import type { Log } from "../log";
import type { PCloudClient } from "../pcloud/client";
import { PCloudError } from "../pcloud/types";
import { Cancelled, type ExecResult, Executor } from "./executor";
import type { LocalVault } from "./local";
import type { StateStore } from "./state";
import type { Action, FilterConfig, FirstSync, Plan, PlanInput, PlanResult, Scope } from "./types";

export type SyncReason = "startup" | "resume" | "interval" | "edit" | "leave" | "manual";

export type SyncState = "idle" | "syncing" | "offline" | "error" | "setup";

export interface SyncStatus {
	state: SyncState;
	message: string;
	progress: { done: number; total: number } | null;
	lastSync: number | null;
	conflicts: string[];
}

export type DeletedWhere = "local" | "remote" | "both";

/** Many files are about to be deleted: true to go ahead, false to bring them back. */
export type ConfirmDeletes = (count: number, where: DeletedWhere) => Promise<boolean>;

const MAX_DIFF_PAGES = 20;
const MAX_HASH_ROUNDS = 3;

export class SyncController {
	private engine: Engine | null = null;
	private running: Promise<void> | null = null;
	private queued: SyncReason | null = null;
	private dirty = new Set<string>();
	private stopped = false;
	private status: SyncStatus = { state: "idle", message: "", progress: null, lastSync: null, conflicts: [] };

	constructor(
		private readonly app: App,
		private readonly auth: AuthManager,
		private readonly device: Device,
		private readonly store: StateStore,
		private readonly local: LocalVault,
		private readonly log: Log,
		private readonly confirmDeletes: ConfirmDeletes,
		private readonly onStatus: (s: SyncStatus) => void,
	) {}

	get current(): SyncStatus {
		return this.status;
	}

	get busy(): boolean {
		return this.running !== null;
	}

	/** False for our own writes, which need no sync. */
	markDirty(path: string): boolean {
		if (this.local.isOwnWrite(path)) return false;
		this.dirty.add(path);
		return true;
	}

	/** Plugin unload: finish the current file and go no further. */
	stop(): Promise<void> {
		this.stopped = true;
		this.queued = null;
		return this.running ?? Promise.resolve();
	}

	get hasDirty(): boolean {
		return this.dirty.size > 0;
	}

	sync(reason: SyncReason): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) {
			// One follow-up run is enough to catch whatever happened meanwhile.
			const quickQueued = !this.queued || this.queued === "edit" || this.queued === "leave";
			if (quickQueued) this.queued = reason;
			return this.running;
		}
		this.running = this.run(reason).finally(() => {
			this.running = null;
			const next = this.queued;
			this.queued = null;
			if (next) void this.sync(next);
		});
		return this.running;
	}

	private async run(reason: SyncReason): Promise<void> {
		const client = this.auth.client();
		const folder = this.device.folder;
		if (!client || !folder) {
			this.set({ state: "setup", message: client ? "Choose a pCloud folder in settings" : "Connect pCloud in settings" });
			return;
		}
		const quick = reason === "edit" || reason === "leave";
		if (quick && this.dirty.size === 0) return;
		// Taken out now, put back if this run doesn't get to them.
		const taken = [...this.dirty];
		this.dirty.clear();
		try {
			const engine = await this.loadEngine();
			engine.setFilter(JSON.stringify(this.filter()));

			this.set({ state: "syncing", message: "Checking pCloud…", progress: null });
			const cursorBefore = engine.cursor();
			await this.refreshRemote(engine, client, folder.id);
			const remoteMoved = engine.cursor() !== cursorBefore;

			const scope: Scope =
				quick && engine.baseSize() > 0 && !remoteMoved ? { type: "paths", paths: taken } : { type: "full" };

			// A fresh device takes the vault from pCloud; otherwise files that differ are kept twice.
			const fresh = engine.baseSize() === 0;
			const firstSync: FirstSync = fresh && this.local.scan().files.length === 0 ? "preferRemote" : "merge";
			if (fresh) this.log.info(`first sync with ${folder.path} (${firstSync})`);
			let plan = await this.plan(engine, client, scope, firstSync);
			if (plan.guard?.kind === "massDelete") {
				this.set({ state: "syncing", message: "Waiting for you", progress: null });
				const deletes = plan.actions.filter((a) => a.kind === "deleteLocal" || a.kind === "deleteRemote");
				const local = deletes.filter((a) => a.kind === "deleteLocal").length;
				const where: DeletedWhere = local === 0 ? "local" : local === deletes.length ? "remote" : "both";
				if (!(await this.confirmDeletes(deletes.length, where))) {
					this.log.info(`restoring ${deletes.length} deleted files instead of deleting them`);
					plan = { ...plan, actions: plan.actions.map(restore) };
				}
			}
			for (const w of plan.warnings) this.log.warn(describeWarning(w));

			const result = await this.execute(engine, client, plan);
			if (this.store.pendingLines > 0 || remoteMoved) await this.store.save(engine);
			this.report(reason, result);
		} catch (e) {
			for (const p of taken) this.dirty.add(p);
			if (this.engine && this.store.pendingLines > 0) await this.store.save(this.engine).catch(() => undefined);
			this.fail(e);
		}
	}

	private async loadEngine(): Promise<Engine> {
		if (this.engine) return this.engine;
		const { engine, problem } = await this.store.load(this.device.id);
		if (problem === "otherDevice") this.log.warn("sync state came from another device, starting over");
		if (problem === "corrupt") this.log.error("sync state was damaged, starting over");
		if (problem === "unsupported") this.log.warn("sync state is from a newer version, starting over");
		this.engine = engine;
		return engine;
	}

	private async refreshRemote(engine: Engine, client: PCloudClient, folderId: string): Promise<void> {
		if (engine.hasRemote() && engine.remoteRoot() === folderId) {
			for (let page = 0; page < MAX_DIFF_PAGES; page++) {
				const cursor = engine.cursor();
				if (!cursor) break;
				const diff = JSON.parse(engine.applyDiff(await client.diffRaw(cursor))) as {
					reset: boolean;
					listFolders: string[];
					caughtUp: boolean;
				};
				if (diff.reset) {
					this.log.info("pCloud asked for a full rescan");
					break;
				}
				await this.listPending(engine, client);
				if (diff.caughtUp) return;
			}
			if (engine.hasRemote() && engine.remoteRoot() === folderId) return;
		}
		// Cursor first: anything that changes during the listing shows up in the next diff.
		const cursor = await client.diffCursor();
		const listing = await client.listFolderRaw(folderId, true);
		await this.store.append(JSON.parse(engine.resetRemote(listing, cursor)) as string[]);
		this.log.info("listed the pCloud vault folder");
	}

	/** Folders that moved into the vault: until listed, their files would look deleted. */
	private async listPending(engine: Engine, client: PCloudClient): Promise<void> {
		for (const id of engine.pendingListings()) {
			try {
				engine.mergeListing(await client.listFolderRaw(id, true));
			} catch (e) {
				// moved away again or deleted since: the folder has nothing to give
				if (!(e instanceof PCloudError && e.isNotFound)) throw e;
				engine.mergeListing(`{"result":0,"metadata":{"isfolder":true,"folderid":${id},"name":"","contents":[]}}`);
			}
		}
	}

	private async plan(engine: Engine, client: PCloudClient, scope: Scope, firstSync: FirstSync): Promise<Plan> {
		this.set({ state: "syncing", message: "Comparing…" });
		const scan = this.local.scan();
		const input: PlanInput = {
			scope,
			local: scan,
			firstSync,
			remoteSha1: {},
			stamp: stamp(new Date()),
			device: defaultDeviceName(),
		};
		for (let round = 0; round <= MAX_HASH_ROUNDS; round++) {
			const result = JSON.parse(engine.plan(JSON.stringify(input))) as PlanResult;
			if (result.type === "ready") return result.plan;
			if (round === MAX_HASH_ROUNDS) break;

			const total = result.local.length + result.remote.length;
			let done = 0;
			const byPath = new Map(scan.files.map((f) => [f.path, f]));
			for (const path of result.local) {
				this.set({ state: "syncing", message: "Hashing…", progress: { done: done++, total } });
				const file = byPath.get(path);
				if (file) file.sha1 = await this.local.hash(path);
			}
			for (const id of result.remote) {
				this.set({ state: "syncing", message: "Hashing…", progress: { done: done++, total } });
				input.remoteSha1[id] = (await client.checksum(id)).sha1;
			}
		}
		throw new Error("could not settle file hashes");
	}

	private async execute(engine: Engine, client: PCloudClient, plan: Plan): Promise<ExecResult> {
		const executor = new Executor(engine, client, this.local, this.store, () => this.stopped);
		return executor.run(plan.actions, (done, total, path) => {
			this.set({ state: "syncing", message: path, progress: { done, total } });
		});
	}

	private report(reason: SyncReason, r: ExecResult): void {
		for (const s of r.skipped) this.log.info(`skipped ${s.path}: ${s.reason}`);
		for (const f of r.failed) this.log.error(`${f.path}: ${f.error}`);
		for (const c of r.conflicts) this.log.warn(`${c} changed in two places, both versions kept`);
		// Look at these again next time.
		for (const s of r.skipped) this.dirty.add(s.path);
		for (const f of r.failed) this.dirty.add(f.path);
		this.log.info(`${reason} sync: ${r.done} done, ${r.skipped.length} skipped, ${r.failed.length} failed`);
		this.set({
			state: r.failed.length ? "error" : "idle",
			message: r.failed.length ? `${r.failed.length} files failed to sync` : "",
			progress: null,
			lastSync: Date.now(),
			conflicts: r.conflicts,
		});
	}

	private fail(e: unknown): void {
		if (e instanceof Cancelled) return;
		const message = e instanceof Error ? e.message : String(e);
		if (e instanceof PCloudError && e.errorClass === "network") {
			this.log.warn(`offline: ${message}`);
			this.set({ state: "offline", message: "Offline", progress: null });
		} else if (e instanceof PCloudError && e.errorClass === "auth") {
			this.log.error(message);
			this.set({ state: "error", message: "pCloud sign-in expired, reconnect in settings", progress: null });
		} else {
			this.log.error(message);
			this.set({ state: "error", message, progress: null });
		}
	}

	private filter(): FilterConfig {
		// requestUrl on mobile struggles past ~25 MB
		const mb = Platform.isMobileApp ? 20 : 200;
		return { configDir: this.app.vault.configDir, exclude: [], maxFileSize: mb * 1024 * 1024 };
	}

	private set(patch: Partial<SyncStatus>): void {
		this.status = { ...this.status, ...patch };
		this.onStatus(this.status);
	}
}

/** "Keep the files" for a planned delete: copy them back from the side that still has them. */
function restore(a: Action): Action {
	if (a.kind === "deleteRemote") return { kind: "download", path: a.path, remote: a.expect, replace: null };
	if (a.kind === "deleteLocal") return { kind: "upload", path: a.path, sha1: null, local: a.expect, replace: null };
	return a;
}

function describeWarning(w: Plan["warnings"][number]): string {
	switch (w.kind) {
		case "collision":
			return `not synced, names differ only in case: ${w.paths.join(", ")}`;
		case "typeConflict":
			return `not synced, file on one side and folder on the other: ${w.path}`;
		case "skipped":
			return `not synced (${w.reason === "tooLarge" ? "too large" : "invalid name"}): ${w.path}`;
	}
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}
