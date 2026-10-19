import { requestUrl } from "obsidian";
import { type Transport, withTimeout } from "./transport";

export const obsidianTransport: Transport = async (req) => {
	const res = await withTimeout(
		requestUrl({
			url: req.url,
			method: req.method,
			body: req.body,
			contentType: req.contentType,
			throw: false,
		}),
		req.timeoutMs,
	);
	return {
		status: res.status,
		headers: res.headers,
		text: () => res.text,
		arrayBuffer: () => res.arrayBuffer,
	};
};
