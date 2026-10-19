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

	/** Connection trouble, timeouts, 5xx, captive portals: worth retrying later. */
	static network(message: string, status = 0): PCloudError {
		return new PCloudError(-status, redact(message), "network", true);
	}

	static http(status: number): PCloudError {
		if (status === 429) return new PCloudError(-status, "too many requests", "rateLimit", true);
		if (status >= 500) return PCloudError.network(`HTTP ${status}`, status);
		return new PCloudError(-status, `HTTP ${status}`, "client", false);
	}
}

/** Error texts may quote request URLs, and those carry the token. */
export function redact(text: string): string {
	return text.replace(/(access_token|auth)=[^&\s"']+/gi, "$1=***");
}
