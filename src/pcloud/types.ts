export const PCLOUD_HOSTS = {
	us: "api.pcloud.com",
	eu: "eapi.pcloud.com",
} as const;

export interface Session {
	host: string;
	token: string;
}

// ids and hashes are strings, they are u64 on the pCloud side
export interface RemoteMetadata {
	isFolder: boolean;
	id: string;
	parent: string | null;
	name: string;
	size: number;
	// unix seconds
	modified: number;
	hash: string | null;
	isDeleted: boolean;
	deletedFileId: string | null;
	contents: RemoteMetadata[] | null;
}

export interface Checksum {
	sha1: string;
	metadata: RemoteMetadata;
}

export interface DiffPage {
	diffid: string;
	entries: { diffid: string; event: string; metadata: RemoteMetadata | null }[];
}

export interface UserInfo {
	email: string;
	quota: number;
	usedQuota: number;
}

export type ErrorClass =
	| "client"
	| "retry"
	| "invalid"
	| "auth"
	| "rateLimit"
	| "temporary"
	| "other"
	| "network";

export class PCloudError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly errorClass: ErrorClass,
		readonly retryable: boolean,
	) {
		super(`pCloud ${code}: ${message}`);
		this.name = "PCloudError";
	}

	get isNotFound(): boolean {
		return this.code === 2002 || this.code === 2005 || this.code === 2009;
	}

	static fromWire(json: string): PCloudError {
		const w = JSON.parse(json) as { code: number; message: string; class: ErrorClass; retryable: boolean };
		return new PCloudError(w.code, w.message, w.class, w.retryable);
	}

	static network(message: string, status = 0): PCloudError {
		const retryable = status === 0 || status === 429 || status >= 500;
		return new PCloudError(-status, message, "network", retryable);
	}
}
