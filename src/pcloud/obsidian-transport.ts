import { requestUrl } from "obsidian";
import type { Transport } from "./transport";

export const obsidianTransport: Transport = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		body: req.body,
		contentType: req.contentType,
		throw: false,
	});
	return {
		status: res.status,
		text: () => res.text,
		arrayBuffer: () => res.arrayBuffer,
	};
};
