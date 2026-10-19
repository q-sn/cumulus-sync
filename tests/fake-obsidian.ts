// Just enough of the obsidian module for running sync code in Node.

export const Platform = {
	isMobile: false,
	isMobileApp: false,
	isDesktopApp: true,
	isAndroidApp: false,
	isIosApp: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
};

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export class TAbstractFile {
	constructor(
		public path: string,
		public vault: FakeVault,
	) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {
	stat = { size: 0, mtime: 0, ctime: 0 };
}

export class TFolder extends TAbstractFile {
	isRoot(): boolean {
		return this.path === "";
	}
}

export class MarkdownView {}

let clock = 1_700_000_000_000;
export const tick = () => (clock += 1000);

export class FakeVault {
	configDir = ".obsidian";
	files = new Map<string, { file: TFile; data: Uint8Array }>();
	folders = new Map<string, TFolder>([["", new TFolder("", this)]]);
	trash: string[] = [];
	adapter = new FakeAdapter();

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.folders.values(), ...[...this.files.values()].map((f) => f.file)];
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
	}

	async readBinary(f: TFile): Promise<ArrayBuffer> {
		const entry = this.files.get(f.path);
		if (!entry) throw new Error(`ENOENT ${f.path}`);
		return entry.data.slice().buffer;
	}

	async createBinary(path: string, data: ArrayBuffer, opts?: { mtime?: number }): Promise<TFile> {
		if (this.getAbstractFileByPath(path)) throw new Error(`exists ${path}`);
		const file = new TFile(path, this);
		this.files.set(path, { file, data: new Uint8Array(data) });
		this.touch(file, data.byteLength, opts?.mtime);
		return file;
	}

	async modifyBinary(file: TFile, data: ArrayBuffer, opts?: { mtime?: number }): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`ENOENT ${file.path}`);
		entry.data = new Uint8Array(data);
		this.touch(file, data.byteLength, opts?.mtime);
	}

	async createFolder(path: string): Promise<void> {
		this.folders.set(path, new TFolder(path, this));
	}

	async rename(file: TAbstractFile, to: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`ENOENT ${file.path}`);
		this.files.delete(file.path);
		entry.file.path = to;
		this.files.set(to, entry);
	}

	// helpers for tests: what the user does by hand
	write(path: string, text: string): void {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!this.folders.has(dir)) this.folders.set(dir, new TFolder(dir, this));
		}
		const data = new TextEncoder().encode(text);
		const existing = this.files.get(path);
		if (existing) {
			existing.data = data;
			this.touch(existing.file, data.byteLength);
		} else {
			const file = new TFile(path, this);
			this.files.set(path, { file, data });
			this.touch(file, data.byteLength);
		}
	}

	text(path: string): string | undefined {
		const e = this.files.get(path);
		return e ? new TextDecoder().decode(e.data) : undefined;
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	private touch(file: TFile, size: number, mtime?: number): void {
		file.stat = { size, mtime: mtime ?? tick(), ctime: file.stat.ctime || clock };
	}
}

export class FakeAdapter {
	store = new Map<string, string>();
	async exists(p: string): Promise<boolean> {
		return this.store.has(p) || [...this.store.keys()].some((k) => k.startsWith(`${p}/`)) || this.dirs.has(p);
	}
	dirs = new Set<string>();
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
	async read(p: string): Promise<string> {
		const v = this.store.get(p);
		if (v === undefined) throw new Error(`ENOENT ${p}`);
		return v;
	}
	async write(p: string, data: string): Promise<void> {
		this.store.set(p, data);
	}
	async append(p: string, data: string): Promise<void> {
		this.store.set(p, (this.store.get(p) ?? "") + data);
	}
}

export class FakeApp {
	vault = new FakeVault();
	local = new Map<string, unknown>();
	secrets = new Map<string, string>();
	fileManager = {
		trashFile: async (f: TAbstractFile) => {
			this.vault.trash.push(f.path);
			this.vault.files.delete(f.path);
		},
	};
	workspace = { iterateAllLeaves: (_cb: unknown) => undefined };
	secretStorage = {
		getSecret: (id: string) => this.secrets.get(id) ?? null,
		setSecret: (id: string, v: string) => void this.secrets.set(id, v),
		listSecrets: () => [...this.secrets.keys()],
	};
	loadLocalStorage(key: string): unknown {
		return this.local.get(key) ?? null;
	}
	saveLocalStorage(key: string, v: unknown): void {
		if (v === null) this.local.delete(key);
		else this.local.set(key, JSON.parse(JSON.stringify(v)));
	}
}

export class Notice {
	constructor(_m: string) {}
}

export class FileSystemAdapter {}
