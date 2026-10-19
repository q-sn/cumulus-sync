// Checks pCloud API behaviour on a real account in temp folders.
// PCLOUD_TOKEN=... [PCLOUD_HOST=eapi.pcloud.com] npm run spike
import { writeFileSync } from "node:fs";
import { loadCore } from "../src/core";
import { PCloudClient } from "../src/pcloud/client";
import type { Transport } from "../src/pcloud/transport";
import { PCLOUD_HOSTS, PCloudError, type RemoteMetadata } from "../src/pcloud/types";

const TIMEOUT_MS = 20_000;

const fetchTransport: Transport = async (req) => {
	const res = await fetch(req.url, {
		method: req.method,
		body: req.body,
		headers: req.contentType ? { "Content-Type": req.contentType } : undefined,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const buf = await res.arrayBuffer();
	return { status: res.status, text: () => new TextDecoder().decode(buf), arrayBuffer: () => buf };
};

interface Check {
	name: string;
	status: "pass" | "fail" | "info";
	detail: unknown;
}
const checks: Check[] = [];

function record(name: string, status: Check["status"], detail: unknown): void {
	checks.push({ name, status, detail });
	const mark = status === "pass" ? "✔" : status === "fail" ? "✘" : "•";
	console.log(`${mark} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function check(name: string, fn: () => Promise<{ ok?: boolean; detail: unknown }>): Promise<void> {
	try {
		const { ok, detail } = await fn();
		record(name, ok === undefined ? "info" : ok ? "pass" : "fail", detail);
	} catch (e) {
		record(name, "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
	}
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function sha1(data: ArrayBuffer): Promise<string> {
	const d = await crypto.subtle.digest("SHA-1", data);
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function connect(token: string): Promise<{ client: PCloudClient; host: string; email: string }> {
	const hosts = process.env.PCLOUD_HOST ? [process.env.PCLOUD_HOST] : Object.values(PCLOUD_HOSTS);
	let last: unknown;
	for (const host of hosts) {
		const client = new PCloudClient(fetchTransport, { host, token }, { maxAttempts: 2 });
		try {
			return { client, host, email: (await client.userInfo()).email };
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

async function removeTree(client: PCloudClient, folderId: string): Promise<void> {
	const folder = await client.listFolder(folderId);
	for (const item of folder.contents ?? []) {
		if (item.isFolder) await removeTree(client, item.id);
		else await client.deleteFile(item.id);
	}
	await client.deleteFolder(folderId);
}

async function main(): Promise<void> {
	const token = process.env.PCLOUD_TOKEN;
	if (!token) throw new Error("Set PCLOUD_TOKEN");
	await loadCore();

	const { client, host, email } = await connect(token);
	const putClient = client;
	const multipartClient = new PCloudClient(fetchTransport, { host, token }, { uploadMode: "multipart" });
	record("account", "info", { host, email: email.replace(/^(.).*@/, "$1***@") });

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const root = await client.createFolderIfNotExists("0", `cumulus-spike-${stamp}`);
	const outside = await client.createFolderIfNotExists("0", `cumulus-spike-${stamp}-outside`);
	const cursor = await client.diffCursor();
	record("setup", "info", { folder: root.name, diffCursor: cursor });

	try {
		let a: RemoteMetadata | null = null;
		const mtime = 1_700_000_000;
		await check("PUT upload keeps mtime", async () => {
			a = await putClient.upload(root.id, "a.md", enc("hello\n"), mtime);
			return { ok: a.modified === mtime, detail: { modified: a.modified, hash: a.hash, id: a.id } };
		});

		await check("hash precision (> 2^53 seen?)", async () => {
			const hashes: string[] = [];
			for (let i = 0; i < 20; i++) {
				hashes.push((await putClient.upload(root.id, `h${i}.txt`, enc(`content ${i} ${stamp}`))).hash ?? "");
			}
			const big = hashes.filter((h) => BigInt(h) > BigInt(Number.MAX_SAFE_INTEGER));
			return { detail: { sample: hashes.slice(0, 3), aboveMaxSafeInteger: `${big.length}/20` } };
		});

		await check("overwrite keeps fileid", async () => {
			const again = await putClient.upload(root.id, "a.md", enc("hello again\n"), mtime + 60);
			const same = a !== null && again.id === (a as RemoteMetadata).id;
			const hashChanged = a !== null && again.hash !== (a as RemoteMetadata).hash;
			a = again;
			return { ok: same && hashChanged, detail: { sameFileId: same, hashChanged } };
		});

		await check("same content → same hash", async () => {
			const x = await putClient.upload(root.id, "same1.md", enc("identical"));
			const y = await putClient.upload(root.id, "same2.md", enc("identical"));
			return { ok: x.hash === y.hash, detail: { x: x.hash, y: y.hash } };
		});

		await check("multipart upload", async () => {
			const b = await multipartClient.upload(root.id, "b é.md", enc("multipart\n"), mtime);
			return { ok: b.name === "b é.md" && b.modified === mtime, detail: { name: b.name, modified: b.modified } };
		});

		await check("empty file (PUT)", async () => {
			const e = await putClient.upload(root.id, "empty.md", new ArrayBuffer(0));
			return { ok: e.size === 0, detail: { size: e.size, hash: e.hash } };
		});

		await check("empty file (multipart)", async () => {
			const e = await multipartClient.upload(root.id, "empty2.md", new ArrayBuffer(0));
			return { ok: e.size === 0, detail: { size: e.size, hash: e.hash } };
		});

		await check("checksumfile sha1 = local sha1", async () => {
			if (!a) throw new Error("a.md missing");
			const remote = await client.checksum((a as RemoteMetadata).id);
			const local = await sha1(enc("hello again\n"));
			return { ok: remote.sha1 === local, detail: { remote: remote.sha1, local } };
		});

		await check("download matches upload", async () => {
			if (!a) throw new Error("a.md missing");
			const bytes = await client.download((a as RemoteMetadata).id);
			const text = new TextDecoder().decode(bytes);
			return { ok: text === "hello again\n", detail: { bytes: bytes.byteLength } };
		});

		await check("NFC vs NFD names", async () => {
			const nfc = "Café.md";
			const nfd = "Café.md";
			await putClient.upload(root.id, nfc, enc("nfc"));
			await putClient.upload(root.id, nfd, enc("nfd"));
			const all = ((await client.listFolder(root.id)).contents ?? []).map((m) => m.name);
			const names = all.filter((n) => n.normalize("NFC") === nfc);
			return {
				detail: {
					listed: all.length,
					distinctEntries: names.length,
					forms: names.map((n) => (n === nfc ? "NFC" : n === nfd ? "NFD" : "other")),
				},
			};
		});

		await check("case-only different names", async () => {
			await putClient.upload(root.id, "Case.md", enc("upper"));
			await putClient.upload(root.id, "case.md", enc("lower"));
			const names = ((await client.listFolder(root.id)).contents ?? [])
				.map((m) => m.name)
				.filter((n) => n.toLowerCase() === "case.md");
			return { detail: { caseSensitive: names.length === 2, names } };
		});

		await check("rename keeps fileid", async () => {
			if (!a) throw new Error("a.md missing");
			const renamed = await client.renameFile((a as RemoteMetadata).id, root.id, "a-renamed.md");
			return { ok: renamed.id === (a as RemoteMetadata).id, detail: { id: renamed.id, name: renamed.name } };
		});

		let sub: RemoteMetadata | null = null;
		await check("move folder in / out (setup)", async () => {
			sub = await client.createFolderIfNotExists(outside.id, "moved");
			await putClient.upload(sub.id, "child.md", enc("child"));
			await client.renameFolder(sub.id, root.id, "moved");
			const out = await client.createFolderIfNotExists(root.id, "leaving");
			await putClient.upload(out.id, "gone.md", enc("gone"));
			await client.renameFolder(out.id, outside.id, "leaving");
			return { detail: "moved 'moved' in and 'leaving' out" };
		});

		await check("diff events since setup", async () => {
			const events: { event: string; name?: string; isFolder?: boolean; parent?: string | null; deletedFileId?: string | null }[] = [];
			let next = cursor;
			for (let page = 0; page < 20; page++) {
				const diff = await client.diff(next, 500);
				for (const e of diff.entries) {
					events.push({
						event: e.event,
						name: e.metadata?.name,
						isFolder: e.metadata?.isFolder,
						parent: e.metadata?.parent === root.id ? "root" : e.metadata?.parent === outside.id ? "outside" : e.metadata?.parent,
						deletedFileId: e.metadata?.deletedFileId,
					});
				}
				if (diff.entries.length === 0 || diff.diffid === next) break;
				next = diff.diffid;
			}
			const childEvents = events.filter((e) => e.name === "child.md" || e.name === "gone.md");
			const renameEvents = events.filter((e) => e.name === "a-renamed.md");
			return {
				detail: {
					total: events.length,
					kinds: [...new Set(events.map((e) => e.event))],
					renameEvents,
					folderMoveEvents: events.filter((e) => e.name === "moved" || e.name === "leaving"),
					childEvents,
				},
			};
		});
	} finally {
		await removeTree(client, root.id).catch((e) => record("cleanup root", "fail", String(e)));
		await removeTree(client, outside.id).catch((e) => record("cleanup outside", "fail", String(e)));
	}

	writeFileSync("spike-report.json", JSON.stringify({ at: new Date().toISOString(), host, checks }, null, 2));
	console.log("\nReport written to spike-report.json (moved files are in pCloud trash).");
}

main().catch((e: unknown) => {
	console.error(e instanceof PCloudError ? `${e.message} (${e.errorClass})` : e);
	process.exitCode = 1;
});
