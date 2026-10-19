import { type App, normalizePath, TextFileView, TFile, TFolder } from "obsidian";
import type { LocalFile, LocalStat } from "./types";

export async function sha1(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Vault access for sync. Uses the Vault API rather than the adapter so the
 * metadata cache and open editors stay consistent with what we write.
 */
export class LocalVault {
	private hashes = new Map<string, { size: number; mtime: number; sha1: string }>();
	private ownWrites = new Map<string, number>();

	constructor(private readonly app: App) {}

	// Obsidian's file index skips dot-folders; those aren't synced anyway.
	scan(): { files: LocalFile[]; folders: string[] } {
		const files: LocalFile[] = [];
		const folders: string[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFile) {
				const cached = this.hashes.get(f.path);
				const fresh = cached && cached.size === f.stat.size && cached.mtime === f.stat.mtime;
				files.push({ path: f.path, size: f.stat.size, mtime: f.stat.mtime, sha1: fresh ? cached.sha1 : null });
			} else if (f instanceof TFolder && !f.isRoot()) {
				folders.push(f.path);
			}
		}
		return { files, folders };
	}

	stat(path: string): LocalStat | null {
		const f = this.file(path);
		return f ? { size: f.stat.size, mtime: f.stat.mtime } : null;
	}

	file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	}

	async read(path: string): Promise<{ data: ArrayBuffer; sha1: string; stat: LocalStat }> {
		const f = this.file(path);
		if (!f) throw new Error(`${path} is gone`);
		const data = await this.app.vault.readBinary(f);
		const hash = await sha1(data);
		const stat = { size: f.stat.size, mtime: f.stat.mtime };
		this.remember(path, stat, hash);
		return { data, sha1: hash, stat };
	}

	async hash(path: string): Promise<string> {
		return (await this.read(path)).sha1;
	}

	/** Writes bytes and returns the stat Obsidian reports afterwards. */
	async write(path: string, data: ArrayBuffer, mtime: number, hash: string): Promise<LocalStat> {
		const existing = this.file(path);
		this.touched(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing, data, { mtime });
		} else {
			await this.ensureFolder(parentOf(path));
			await this.app.vault.createBinary(path, data, { mtime });
		}
		const stat = this.stat(path);
		if (!stat) throw new Error(`${path} was not written`);
		this.remember(path, stat, hash);
		return stat;
	}

	/** Always recoverable: system trash, or the vault's .trash where there is none. */
	async trash(path: string): Promise<void> {
		const f = this.file(path);
		this.touched(path);
		if (f) await this.app.vault.trash(f, true);
		this.hashes.delete(path);
	}

	/** A conflict copy of `path` with exactly this content already exists. */
	async hasCopy(path: string, hash: string): Promise<boolean> {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const dir = parentOf(path);
		const prefix = `${dir ? `${dir}/` : ""}${stem} (conflict `;
		for (const f of this.app.vault.getFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const cached = this.hashes.get(f.path);
			const known = cached && cached.size === f.stat.size && cached.mtime === f.stat.mtime;
			if ((known ? cached.sha1 : (await this.read(f.path)).sha1) === hash) return true;
		}
		return false;
	}

	/** Plain rename: links in other notes are left as they are on the other side too. */
	async rename(from: string, to: string): Promise<LocalStat> {
		const f = this.file(from);
		if (!f) throw new Error(`${from} is gone`);
		await this.ensureFolder(parentOf(to));
		this.touched(from, to);
		await this.app.vault.rename(f, to);
		this.hashes.delete(from);
		const stat = this.stat(to);
		if (!stat) throw new Error(`${to} was not renamed`);
		return stat;
	}

	/** `Note (conflict ...).md` is taken: append a counter. */
	freePath(path: string): string {
		if (!this.app.vault.getAbstractFileByPath(path)) return path;
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		for (let i = 2; ; i++) {
			const candidate = `${stem} ${i}${ext}`;
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
	}

	/** Open in an editor with changes that haven't hit the disk yet. */
	hasUnsavedEdits(path: string): boolean {
		let dirty = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			// notes, canvases and other text views keep edits in memory for a moment
			if (view instanceof TextFileView && view.file?.path === path && view.getViewData() !== view.data) {
				dirty = true;
			}
		});
		return dirty;
	}

	/** True for vault events caused by our own writes, so they don't trigger another sync. */
	isOwnWrite(path: string): boolean {
		const at = this.ownWrites.get(path);
		if (at === undefined) return false;
		this.ownWrites.delete(path);
		return Date.now() - at < 5000;
	}

	private touched(...paths: string[]): void {
		for (const p of paths) this.ownWrites.set(p, Date.now());
	}

	private remember(path: string, stat: LocalStat, hash: string): void {
		this.hashes.set(path, { ...stat, sha1: hash });
	}

	private async ensureFolder(dir: string): Promise<void> {
		if (!dir) return;
		let current = "";
		for (const part of dir.split("/")) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) await this.app.vault.createFolder(current);
			else if (!(existing instanceof TFolder)) throw new Error(`${current} is a file, expected a folder`);
		}
	}
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
