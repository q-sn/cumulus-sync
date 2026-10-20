export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT";
	body?: ArrayBuffer;
	contentType?: string;
	/** Give up after this long; requestUrl itself never times out. */
	timeoutMs?: number;
}

export interface HttpResponse {
	status: number;
	headers?: Record<string, string>;
	text(): string;
	arrayBuffer(): ArrayBuffer;
}

// requestUrl in Obsidian, fetch in scripts
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`no answer in ${Math.round(ms / 1000)} s`);
		this.name = "TimeoutError";
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
	if (!ms) return promise;
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new TimeoutError(ms)), ms);
		promise.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}
