export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT";
	body?: ArrayBuffer;
	contentType?: string;
}

export interface HttpResponse {
	status: number;
	text(): string;
	arrayBuffer(): ArrayBuffer;
}

// requestUrl in Obsidian, fetch in scripts
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
