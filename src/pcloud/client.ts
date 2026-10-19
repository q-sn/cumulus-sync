import { pcloudChecksum, pcloudDiff, pcloudError, pcloudMetadata, pcloudUpload } from "../core";
import type { HttpRequest, HttpResponse, Transport } from "./transport";
import {
	type Checksum,
	type DiffPage,
	PCloudError,
	type RemoteMetadata,
	type Session,
	type UserInfo,
} from "./types";

type Params = Record<string, string | number | boolean | undefined>;

export interface ClientOptions {
	maxAttempts?: number;
	backoffMs?: number;
	// PUT with raw body isn't documented but works; multipart is the documented way
	uploadMode?: "put" | "multipart";
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BASE_TIMEOUT_MS = 30_000;
// slow mobile link, about 64 KB/s
const MS_PER_BYTE = 1 / 64;
const timeoutFor = (bytes: number) => BASE_TIMEOUT_MS + Math.round(bytes * MS_PER_BYTE);

const DOWNLOAD_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pcloud\.com$/i;

// metadata is parsed in wasm: hash and ids are u64 and break JSON.parse
export class PCloudClient {
	private readonly maxAttempts: number;
	private readonly backoffMs: number;
	private readonly uploadMode: "put" | "multipart";
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly transport: Transport,
		private readonly session: Session,
		options: ClientOptions = {},
	) {
		this.maxAttempts = options.maxAttempts ?? 4;
		this.backoffMs = options.backoffMs ?? 1000;
		this.uploadMode = options.uploadMode ?? "put";
		this.sleep = options.sleep ?? defaultSleep;
	}

	async userInfo(): Promise<UserInfo> {
		const body = await this.call("userinfo");
		const raw = JSON.parse(body) as { email: string; quota: number; usedquota: number };
		return { email: raw.email, quota: raw.quota, usedQuota: raw.usedquota };
	}

	listFolderRaw(folderId: string, recursive: boolean): Promise<string> {
		return this.call("listfolder", { folderid: folderId, recursive: recursive ? 1 : undefined });
	}

	async listFolder(folderId: string, recursive = false): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.listFolderRaw(folderId, recursive));
	}

	async statFile(fileId: string): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.call("stat", { fileid: fileId }));
	}

	async checksum(fileId: string): Promise<Checksum> {
		return parsed<Checksum>(pcloudChecksum, await this.call("checksumfile", { fileid: fileId }));
	}

	diffRaw(diffid: string, limit = 1000): Promise<string> {
		return this.call("diff", { diffid, limit });
	}

	async diffCursor(): Promise<string> {
		return parsed<DiffPage>(pcloudDiff, await this.call("diff", { last: 0 })).diffid;
	}

	async diff(diffid: string, limit = 1000): Promise<DiffPage> {
		return parsed<DiffPage>(pcloudDiff, await this.diffRaw(diffid, limit));
	}

	createFolderRaw(parentId: string, name: string): Promise<string> {
		return this.call("createfolderifnotexists", { folderid: parentId, name });
	}

	async createFolderIfNotExists(parentId: string, name: string): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.createFolderRaw(parentId, name));
	}

	async upload(folderId: string, name: string, data: ArrayBuffer, mtimeSec?: number): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudUpload, await this.uploadRaw(folderId, name, data, mtimeSec));
	}

	/** `renameIfExists`: don't overwrite a file of the same name, keep both. */
	uploadRaw(
		folderId: string,
		name: string,
		data: ArrayBuffer,
		mtimeSec?: number,
		opts: { renameIfExists?: boolean } = {},
	): Promise<string> {
		const params: Params = {
			folderid: folderId,
			nopartial: 1,
			mtime: mtimeSec,
			renameifexists: opts.renameIfExists ? 1 : undefined,
		};
		const timeoutMs = timeoutFor(data.byteLength);
		// PUT with an empty body never gets a response from pCloud
		if (this.uploadMode === "put" && data.byteLength > 0) {
			return this.call("uploadfile", { ...params, filename: name }, { method: "PUT", body: data, timeoutMs });
		}
		const form = multipart(name, data);
		return this.call("uploadfile", params, {
			method: "POST",
			body: form.body,
			contentType: form.contentType,
			timeoutMs,
		});
	}

	/** `size` only sets how long to wait. */
	async download(fileId: string, size = 0): Promise<ArrayBuffer> {
		const body = await this.call("getfilelink", { fileid: fileId });
		const link = JSON.parse(body) as { hosts: string[]; path: string };
		let lastError: PCloudError | null = null;
		// any of the hosts will do, as long as they are pCloud's
		const hosts = link.hosts.filter((h) => DOWNLOAD_HOST.test(h));
		if (hosts.length === 0) throw new Error("pCloud gave no usable download address");
		for (const host of hosts) {
			const req: HttpRequest = { url: `https://${host}${link.path}`, method: "GET", timeoutMs: timeoutFor(size) };
			const res = await this.send(req).catch(
				(e: unknown) => {
					lastError = asNetworkError(e);
					return null;
				},
			);
			if (!res) continue;
			if (res.status === 200) return res.arrayBuffer();
			lastError = PCloudError.http(res.status);
		}
		throw lastError ?? PCloudError.network("download failed");
	}

	async deleteFile(fileId: string): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.call("deletefile", { fileid: fileId }));
	}

	async deleteFolder(folderId: string): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.call("deletefolder", { folderid: folderId }));
	}

	renameFileRaw(fileId: string, toFolderId: string, toName: string): Promise<string> {
		return this.call("renamefile", { fileid: fileId, tofolderid: toFolderId, toname: toName });
	}

	async renameFile(fileId: string, toFolderId: string, toName: string): Promise<RemoteMetadata> {
		return parsed<RemoteMetadata>(pcloudMetadata, await this.renameFileRaw(fileId, toFolderId, toName));
	}

	async renameFolder(folderId: string, toFolderId: string, toName: string): Promise<RemoteMetadata> {
		const body = await this.call("renamefolder", { folderid: folderId, tofolderid: toFolderId, toname: toName });
		return parsed<RemoteMetadata>(pcloudMetadata, body);
	}

	async logout(): Promise<void> {
		await this.call("logout");
	}

	private async call(
		method: string,
		params: Params = {},
		req: Omit<HttpRequest, "url"> = { method: "GET" },
	): Promise<string> {
		const query = new URLSearchParams({ timeformat: "timestamp", access_token: this.session.token });
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) query.set(key, String(value === true ? 1 : value === false ? 0 : value));
		}
		const url = `https://${this.session.host}/${method}?${query.toString()}`;

		for (let attempt = 1; ; attempt++) {
			let error: PCloudError;
			let retryAfterMs = 0;
			try {
				const res = await this.send({ timeoutMs: BASE_TIMEOUT_MS, ...req, url });
				if (res.status !== 200) {
					error = PCloudError.http(res.status);
					retryAfterMs = retryAfter(res);
				} else {
					const body = res.text();
					const wireError = pcloudError(body);
					if (wireError === undefined) return body;
					error = PCloudError.fromWire(wireError);
					// not JSON at all: a captive portal or a proxy page, i.e. not really online
					if (error.code === 0) error = PCloudError.network(`${method}: unexpected response`);
				}
			} catch (e) {
				error = asNetworkError(e);
			}
			if (!error.retryable || attempt >= this.maxAttempts) throw error;
			const jitter = 0.5 + Math.random();
			await this.sleep(Math.max(retryAfterMs, this.backoffMs * 2 ** (attempt - 1) * jitter));
		}
	}

	private send(req: HttpRequest): Promise<HttpResponse> {
		return this.transport(req);
	}
}

function parsed<T>(parser: (body: string) => string, body: string): T {
	try {
		return JSON.parse(parser(body)) as T;
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("{")) throw PCloudError.fromWire(e.message);
		throw e;
	}
}

function retryAfter(res: HttpResponse): number {
	const header = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 0;
}

function asNetworkError(e: unknown): PCloudError {
	if (e instanceof PCloudError) return e;
	return PCloudError.network(e instanceof Error ? e.message : String(e));
}

function multipart(filename: string, data: ArrayBuffer): { body: ArrayBuffer; contentType: string } {
	const boundary = `----cumulus${Math.random().toString(16).slice(2)}`;
	const enc = new TextEncoder();
	const safeName = filename.replace(/["\r\n]/g, "_");
	const head = enc.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`,
	);
	const tail = enc.encode(`\r\n--${boundary}--\r\n`);
	const out = new Uint8Array(head.length + data.byteLength + tail.length);
	out.set(head, 0);
	out.set(new Uint8Array(data), head.length);
	out.set(tail, head.length + data.byteLength);
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
