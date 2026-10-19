import type { DataAdapter } from "obsidian";
import { Engine } from "../core";

const SLOTS = ["state-a.txt", "state-b.txt"] as const;
const JOURNAL = "journal.jsonl";

export type LoadProblem = "otherDevice" | "unsupported" | "corrupt" | null;

/**
 * Engine state in the plugin folder. Snapshots alternate between two files
 * (adapter.rename can't replace an existing file) and the journal holds
 * baseline changes made since the newest one.
 */
export class StateStore {
	private slot = 0;
	private journalLines = 0;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly dir: string,
	) {}

	async load(deviceId: string): Promise<{ engine: Engine; problem: LoadProblem }> {
		const slots = await Promise.all(SLOTS.map((name) => this.readSlot(name)));
		const best = slots
			.map((s, i) => ({ ...s, i }))
			.filter((s) => s.snapshot !== null)
			.sort((a, b) => b.seq - a.seq);
		const journal = await this.read(JOURNAL);

		for (const candidate of best) {
			try {
				this.slot = candidate.i;
				const engine = Engine.load(deviceId, candidate.snapshot, journal);
				this.journalLines = journal?.split("\n").filter(Boolean).length ?? 0;
				return { engine, problem: null };
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (message === "otherDevice") return { engine: await this.fresh(deviceId), problem: "otherDevice" };
				if (message === "unsupported") return { engine: await this.fresh(deviceId), problem: "unsupported" };
				// damaged slot: fall back to the older one
			}
		}
		if (best.length > 0) return { engine: await this.fresh(deviceId), problem: "corrupt" };
		try {
			return { engine: Engine.load(deviceId, null, journal), problem: null };
		} catch {
			return { engine: await this.fresh(deviceId), problem: "corrupt" };
		}
	}

	async append(lines: string | string[]): Promise<void> {
		const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
		if (list.length === 0) return;
		await this.ensureDir();
		const path = `${this.dir}/${JOURNAL}`;
		const text = list.map((l) => `${l}\n`).join("");
		if (await this.adapter.exists(path)) await this.adapter.append(path, text);
		else await this.adapter.write(path, text);
		this.journalLines += list.length;
	}

	get pendingLines(): number {
		return this.journalLines;
	}

	async save(engine: Engine): Promise<void> {
		await this.ensureDir();
		const next = 1 - this.slot;
		await this.adapter.write(`${this.dir}/${SLOTS[next]}`, `${engine.seq()}\n${engine.snapshot()}`);
		this.slot = next;
		// Lines up to engine.seq() are in the snapshot now; load() skips them anyway.
		await this.adapter.write(`${this.dir}/${JOURNAL}`, "");
		this.journalLines = 0;
	}

	async clear(deviceId: string): Promise<Engine> {
		return this.fresh(deviceId);
	}

	private async fresh(deviceId: string): Promise<Engine> {
		await this.ensureDir();
		for (const name of [...SLOTS, JOURNAL]) {
			const path = `${this.dir}/${name}`;
			if (await this.adapter.exists(path)) await this.adapter.write(path, "");
		}
		this.journalLines = 0;
		return new Engine(deviceId);
	}

	private async readSlot(name: string): Promise<{ seq: number; snapshot: string | null }> {
		const text = await this.read(name);
		const nl = text?.indexOf("\n") ?? -1;
		if (!text || nl < 0) return { seq: -1, snapshot: null };
		const seq = Number(text.slice(0, nl));
		return Number.isFinite(seq) ? { seq, snapshot: text.slice(nl + 1) } : { seq: -1, snapshot: null };
	}

	private async read(name: string): Promise<string | null> {
		const path = `${this.dir}/${name}`;
		return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
	}

	private async ensureDir(): Promise<void> {
		if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
	}
}
