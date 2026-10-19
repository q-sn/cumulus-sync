// In-memory pCloud speaking the HTTP JSON API, enough for sync tests.
// Hashes are 64-bit and usually above 2^53, like the real ones.

import type { HttpRequest, HttpResponse, Transport } from "../src/pcloud/transport";

interface Folder {
	id: number;
	parent: number;
	name: string;
}

interface File {
	id: number;
	parent: number;
	name: string;
	data: Uint8Array;
	modified: number;
	hash: bigint;
}

interface Event {
	diffid: number;
	event: string;
	meta: string;
}

function fnv64(data: Uint8Array): bigint {
	let h = 0xcbf29ce484222325n;
	for (const b of data) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
}

const enc = new TextEncoder();

export class FakePCloud {
	folders = new Map<number, Folder>();
	files = new Map<number, File>();
	events: Event[] = [];
	trash: string[] = [];
	calls: string[] = [];
	private nextId = 100;
	private diffid = 1000;
	private now = 1_700_000_000;

	constructor() {
		this.folders.set(0, { id: 0, parent: -1, name: "" });
	}

	transport: Transport = async (req) => this.handle(req);

	// --- test helpers: what pCloud Drive on the desktop would do ---

	mkdirs(path: string): number {
		let current = 0;
		for (const part of path.split("/").filter(Boolean)) {
			const found = [...this.folders.values()].find((f) => f.parent === current && f.name === part);
			current = found ? found.id : this.createFolder(current, part).id;
		}
		return current;
	}

	put(path: string, text: string): void {
		const dir = path.split("/").slice(0, -1).join("/");
		this.upload(this.mkdirs(dir), path.split("/").pop() ?? "", enc.encode(text), undefined);
	}

	text(path: string): string | undefined {
		const f = this.fileAt(path);
		return f ? new TextDecoder().decode(f.data) : undefined;
	}

	remove(path: string): void {
		const f = this.fileAt(path);
		if (f) this.deleteFile(f);
	}

	moveFolder(from: string, toParent: string): void {
		const id = this.mkdirs(from);
		const folder = this.folders.get(id);
		if (!folder) return;
		folder.parent = this.mkdirs(toParent);
		this.emit("modifyfolder", this.folderMeta(folder, false));
	}

	paths(root: string): string[] {
		const rootId = this.mkdirs(root);
		const out: string[] = [];
		for (const f of this.files.values()) {
			const p = this.pathOf(f.parent, rootId);
			if (p !== null) out.push(p ? `${p}/${f.name}` : f.name);
		}
		return out.sort();
	}

	// --- server ---

	private async handle(req: HttpRequest): Promise<HttpResponse> {
		const url = new URL(req.url);
		if (url.hostname === "dl.fake") {
			const f = this.files.get(Number(url.pathname.split("/").pop()));
			return f ? bytes(f.data) : status(404);
		}
		const method = url.pathname.slice(1);
		const q = url.searchParams;
		this.calls.push(method);
		if (q.get("access_token") !== "test-token") return json(`{"result":2094,"error":"Invalid 'access_token' provided."}`);
		const file = () => this.files.get(Number(q.get("fileid")));
		const notFound = `{"result":2009,"error":"File not found."}`;

		switch (method) {
			case "userinfo":
				return json(`{"result":0,"email":"test@example.com","quota":10737418240,"usedquota":1024}`);
			case "listfolder": {
				const folder = this.folders.get(Number(q.get("folderid")));
				if (!folder) return json(`{"result":2005,"error":"Directory does not exist."}`);
				return json(`{"result":0,"metadata":${this.folderMeta(folder, true, q.get("recursive") === "1")}}`);
			}
			case "diff": {
				if (q.get("last") === "0") return json(`{"result":0,"diffid":${this.diffid}}`);
				const after = Number(q.get("diffid"));
				const limit = Number(q.get("limit") ?? 1000);
				const page = this.events.filter((e) => e.diffid > after).slice(0, limit);
				const last = page.length ? page[page.length - 1]?.diffid : after;
				const entries = page.map((e) => `{"diffid":${e.diffid},"time":1,"event":"${e.event}","metadata":${e.meta}}`);
				return json(`{"result":0,"diffid":${last},"entries":[${entries.join(",")}]}`);
			}
			case "uploadfile": {
				const parent = Number(q.get("folderid"));
				if (!this.folders.has(parent)) return json(`{"result":2005,"error":"Directory does not exist."}`);
				const mtime = q.get("mtime") ? Number(q.get("mtime")) : undefined;
				const f = this.upload(parent, q.get("filename") ?? "", new Uint8Array(req.body ?? new ArrayBuffer(0)), mtime);
				return json(`{"result":0,"fileids":[${f.id}],"metadata":[${this.fileMeta(f)}]}`);
			}
			case "stat": {
				const f = file();
				return json(f ? `{"result":0,"metadata":${this.fileMeta(f)}}` : notFound);
			}
			case "checksumfile": {
				const f = file();
				if (!f) return json(notFound);
				const d = await crypto.subtle.digest("SHA-1", f.data.slice().buffer);
				const sha1 = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
				return json(`{"result":0,"sha1":"${sha1}","metadata":${this.fileMeta(f)}}`);
			}
			case "getfilelink": {
				const f = file();
				return json(f ? `{"result":0,"hosts":["dl.fake"],"path":"/f/${f.id}","expires":"x"}` : notFound);
			}
			case "deletefile": {
				const f = file();
				if (!f) return json(notFound);
				this.deleteFile(f);
				return json(`{"result":0,"metadata":${this.fileMeta(f, true)}}`);
			}
			case "createfolderifnotexists": {
				const parent = Number(q.get("folderid"));
				const name = q.get("name") ?? "";
				const existing = [...this.folders.values()].find((f) => f.parent === parent && f.name === name);
				const folder = existing ?? this.createFolder(parent, name);
				return json(`{"result":0,"created":${!existing},"metadata":${this.folderMeta(folder, false)}}`);
			}
			case "renamefile": {
				const f = file();
				if (!f) return json(notFound);
				if (q.get("tofolderid")) f.parent = Number(q.get("tofolderid"));
				if (q.get("toname")) f.name = q.get("toname") ?? f.name;
				this.emit("modifyfile", this.fileMeta(f));
				return json(`{"result":0,"metadata":${this.fileMeta(f)}}`);
			}
			case "logout":
				return json(`{"result":0}`);
			default:
				return status(404);
		}
	}

	private upload(parent: number, name: string, data: Uint8Array, mtime: number | undefined): File {
		const existing = [...this.files.values()].find((f) => f.parent === parent && f.name === name);
		const modified = mtime ?? ++this.now;
		if (existing) {
			existing.data = data;
			existing.hash = fnv64(data);
			existing.modified = modified;
			this.emit("modifyfile", this.fileMeta(existing));
			return existing;
		}
		const f: File = { id: this.nextId++, parent, name, data, modified, hash: fnv64(data) };
		this.files.set(f.id, f);
		this.emit("createfile", this.fileMeta(f));
		return f;
	}

	private createFolder(parent: number, name: string): Folder {
		const folder = { id: this.nextId++, parent, name };
		this.folders.set(folder.id, folder);
		this.emit("createfolder", this.folderMeta(folder, false));
		return folder;
	}

	private deleteFile(f: File): void {
		this.files.delete(f.id);
		this.trash.push(f.name);
		this.emit("deletefile", this.fileMeta(f, true));
	}

	private emit(event: string, meta: string): void {
		this.events.push({ diffid: ++this.diffid, event, meta });
	}

	private fileAt(path: string): File | undefined {
		const parts = path.split("/");
		const name = parts.pop();
		const parent = this.mkdirs(parts.join("/"));
		return [...this.files.values()].find((f) => f.parent === parent && f.name === name);
	}

	private pathOf(folderId: number, root: number): string | null {
		const parts: string[] = [];
		let id = folderId;
		while (id !== root) {
			const f = this.folders.get(id);
			if (!f || f.parent < 0) return null;
			parts.unshift(f.name);
			id = f.parent;
		}
		return parts.join("/");
	}

	private fileMeta(f: File, deleted = false): string {
		return `{"isfolder":false,"fileid":${f.id},"parentfolderid":${f.parent},"name":${JSON.stringify(f.name)},"size":${f.data.byteLength},"modified":${f.modified},"hash":${f.hash.toString()}${deleted ? ',"isdeleted":true' : ""}}`;
	}

	private folderMeta(folder: Folder, withContents: boolean, recursive = false): string {
		const parent = folder.parent >= 0 ? `,"parentfolderid":${folder.parent}` : "";
		const head = `{"isfolder":true,"folderid":${folder.id}${parent},"name":${JSON.stringify(folder.name)},"modified":1`;
		if (!withContents) return `${head}}`;
		const subfolders = [...this.folders.values()].filter((f) => f.parent === folder.id && f.id !== 0);
		const files = [...this.files.values()].filter((f) => f.parent === folder.id);
		const contents = [
			...subfolders.map((f) => (recursive ? this.folderMeta(f, true, true) : this.folderMeta(f, false))),
			...files.map((f) => this.fileMeta(f)),
		];
		return `${head},"contents":[${contents.join(",")}]}`;
	}
}

function json(body: string): HttpResponse {
	const buf = enc.encode(body).buffer as ArrayBuffer;
	return { status: 200, text: () => body, arrayBuffer: () => buf };
}

function bytes(data: Uint8Array): HttpResponse {
	const buf = data.slice().buffer as ArrayBuffer;
	return { status: 200, text: () => new TextDecoder().decode(data), arrayBuffer: () => buf };
}

function status(code: number): HttpResponse {
	return { status: code, text: () => "", arrayBuffer: () => new ArrayBuffer(0) };
}
