import type { App } from "obsidian";
import type { AuthManager } from "../auth";
import type { Engine } from "../core";
import { defaultDeviceName, type Device } from "../device";
import type { Log } from "../log";
import type { PCloudClient } from "../pcloud/client";
import { PCloudError } from "../pcloud/types";
import { type CumulusSettings, maxFileSizeBytes } from "../settings-data";
import { type ExecResult, Executor } from "./executor";
import type { LocalVault } from "./local";
import type { StateStore } from "./state";
import type { FilterConfig, FirstSync, Plan, PlanInput, PlanResult, Scope } from "./types";

export type SyncReason = "startup" | "resume" | "interval" | "edit" | "leave" | "manual" | "preview";

export type SyncState = "idle" | "syncing" | "offline" | "error" | "setup";

export interface SyncStatus {
	state: SyncState;
	message: string;
	progress: { done: number; total: number } | null;
	lastSync: number | null;
	conflicts: string[];
}

export interface Confirm {
	/** Resolves with the first-sync mode to use, or null to cancel. */
	(plan: Plan, firstSync: FirstSync): Promise<FirstSync | null>;
}

const MAX_DIFF_PAGES = 20;
const MAX_HASH_ROUNDS = 3;

export class SyncController {
	private engine: Engine | null = null;
	private running: Promise<void> | null = null;
	private queued: SyncReason | null = null;
	private dirty = new Set<string>();
	private status: SyncStatus = { state: "idle", message: "", progress: null, lastSync: null, conflicts: [] };

	constructor(
		private readonly app: App,
		private readonly auth: AuthManager,
		private readonly device: Device,
		private readonly store: StateStore,
		private readonly local: LocalVault,
		private readonly log: Log,
		private readonly settings: () => CumulusSettings,
		private readonly confirm: Confirm,
		private readonly onStatus: (s: SyncStatus) => void,
	) {}

	get current(): SyncStatus {
		return this.status;
	}

	get busy(): boolean {
		return this.running !== null;
	}

	markDirty(path: string): void {
		if (!this.local.isOwnWrite(path)) this.dirty.add(path);
	}

	get hasDirty(): boolean {
		return this.dirty.size > 0;
	}

	/** Forgets all sync history on this device; the next sync is a first sync. */
	async resetState(): Promise<void> {
		await this.running;
		this.engine = await this.store.clear(this.device.id);
		this.log.warn("sync state reset");
	}

	sync(reason: SyncReason): Promise<void> {
		if (this.running) {
			// One follow-up run is enough to catch whatever happened meanwhile.
			const quickQueued = !this.queued || this.queued === "edit" || this.queued === "leave";
			if (reason !== "preview" && quickQueued) this.queued = reason;
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
		if (!this.device.enabled || !client || !folder) {
			this.set({ state: "setup", message: setupMessage(!!client, !!folder, this.device.enabled) });
			return;
		}
		try {
			const engine = await this.loadEngine();
			engine.setFilter(JSON.stringify(this.filter()));

			this.set({ state: "syncing", message: "Checking pCloud…", progress: null });
			await this.refreshRemote(engine, client, folder.id);

			const quick = (reason === "edit" || reason === "leave") && engine.baseSize() > 0;
			const taken = quick ? [...this.dirty] : null;
			const scope: Scope = taken && taken.length > 0 ? { type: "paths", paths: taken } : { type: "full" };
			if (scope.type === "full") this.dirty.clear();
			else for (const p of scope.paths) this.dirty.delete(p);

			let firstSync: FirstSync = "merge";
			let plan = await this.plan(engine, client, scope, firstSync);
			if (plan.guard || reason === "preview") {
				for (;;) {
					this.set({ state: "syncing", message: "Waiting for confirmation", progress: null });
					const chosen = await this.confirm(plan, firstSync);
					if (!chosen) {
						this.log.info("sync cancelled");
						this.set({ state: "idle", message: "Sync cancelled" });
						return;
					}
					if (chosen === firstSync) break;
					// another first-sync mode was picked: show the plan it produces
					firstSync = chosen;
					plan = await this.plan(engine, client, scope, firstSync);
				}
			}
			for (const w of plan.warnings) this.log.warn(describeWarning(w));

			const result = await this.execute(engine, client, plan);
			await this.store.save(engine);
			this.report(reason, result);
		} catch (e) {
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
				for (const id of diff.listFolders) engine.mergeListing(await client.listFolderRaw(id, true));
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

	private async plan(engine: Engine, client: PCloudClient, scope: Scope, firstSync: FirstSync): Promise<Plan> {
		this.set({ state: "syncing", message: "Comparing…" });
		const scan = this.local.scan();
		const input: PlanInput = {
			scope,
			local: scan,
			firstSync,
			remoteSha1: {},
			stamp: stamp(new Date()),
			device: this.settings().deviceName || defaultDeviceName(),
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
		const executor = new Executor(engine, client, this.local, this.store);
		return executor.run(plan.actions, (done, total, path) => {
			this.set({ state: "syncing", message: path, progress: { done, total } });
		});
	}

	private report(reason: SyncReason, r: ExecResult): void {
		for (const s of r.skipped) this.log.info(`skipped ${s.path}: ${s.reason}`);
		for (const f of r.failed) this.log.error(`${f.path}: ${f.error}`);
		for (const c of r.conflicts) this.log.warn(`conflict in ${c}, the other version was saved next to it`);
		// Skipped files are looked at again on the next full sync.
		for (const s of r.skipped) this.dirty.add(s.path);
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
		const s = this.settings();
		return { configDir: this.app.vault.configDir, exclude: s.exclude, maxFileSize: maxFileSizeBytes(s) };
	}

	private set(patch: Partial<SyncStatus>): void {
		this.status = { ...this.status, ...patch };
		this.onStatus(this.status);
	}
}

function setupMessage(connected: boolean, folder: boolean, enabled: boolean): string {
	if (!connected) return "Connect pCloud in settings";
	if (!folder) return "Choose a pCloud folder in settings";
	if (!enabled) return "Sync is off on this device";
	return "";
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
