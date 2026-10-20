import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { App } from "obsidian";
import { AuthManager } from "../src/auth";
import { loadCore } from "../src/core";
import { Device } from "../src/device";
import { Log } from "../src/log";
import { type DeletedWhere, SyncController } from "../src/sync/controller";
import { LocalVault } from "../src/sync/local";
import { StateStore } from "../src/sync/state";
import { FakeApp } from "./fake-obsidian";
import { FakePCloud } from "./fake-pcloud";

// the plugin code uses window timers, as Obsidian asks
(globalThis as { window?: unknown }).window ??= globalThis;

const VAULT = "Notes/Vault";

interface Phone {
	app: FakeApp;
	log: Log;
	/** Mass-delete questions asked so far. */
	asked: { count: number; where: DeletedWhere }[];
	/** Answer to the next mass-delete question: delete (true) or keep the files. */
	allowDeletes: boolean;
	sync(): Promise<void>;
	/** Sync without asserting success; returns the state it ended in. */
	trySync(): Promise<string>;
	useFolder(path: string): void;
	restart(): Phone;
}

function phone(cloud: FakePCloud, app = new FakeApp()): Phone {
	app.local.set("cumulus-pcloud-host", "eapi.pcloud.com");
	const device = new Device(app as unknown as App);
	app.secrets.set(`cumulus-token-${device.id}`, "test-token");
	if (!device.folder) device.update({ folder: { id: String(cloud.mkdirs(VAULT)), path: `/${VAULT}` } });
	const log = new Log();
	const asked: Phone["asked"] = [];
	const controller = new SyncController(
		app as unknown as App,
		new AuthManager(app as unknown as App, cloud.transport, device.id),
		device,
		new StateStore(app.vault.adapter as never, ".obsidian/plugins/cumulus-sync"),
		new LocalVault(app as unknown as App),
		log,
		async (count, where) => {
			asked.push({ count, where });
			return self.allowDeletes;
		},
		() => undefined,
	);
	const self: Phone = {
		app,
		log,
		asked,
		allowDeletes: true,
		async sync() {
			await controller.sync("manual");
			const failed = controller.current.state === "error";
			assert.ok(!failed, `sync failed: ${controller.current.message}\n${log.all().map((e) => e.message).join("\n")}`);
		},
		async trySync() {
			await controller.sync("manual");
			return controller.current.state;
		},
		useFolder(path: string) {
			device.update({ folder: { id: String(cloud.mkdirs(path)), path: `/${path}` } });
		},
		restart: () => phone(cloud, app),
	};
	return self;
}

/** The summary line the controller logs after each sync. */
function lastRun(p: Phone): string {
	return [...p.log.all()].reverse().find((e) => e.message.includes(" sync: "))?.message ?? "";
}

before(async () => {
	await loadCore();
});

describe("sync against a fake pCloud", () => {
	test("new phone pulls the vault, then has nothing to do", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/Welcome.md`, "hello");
		cloud.put(`${VAULT}/Projects/Plan.md`, "plan");
		cloud.put(`${VAULT}/img/cat.png`, "\u0000\u0001binary");
		const p = phone(cloud);

		await p.sync();
		assert.equal(p.asked.length, 0, "a first sync asks nothing");
		assert.ok(!p.app.vault.paths().some((x) => x.includes("conflict")));
		assert.deepEqual(p.app.vault.paths(), ["Projects/Plan.md", "Welcome.md", "img/cat.png"]);
		assert.equal(p.app.vault.text("Projects/Plan.md"), "plan");

		await p.sync();
		assert.match(lastRun(p), /0 done, 0 skipped, 0 failed/);
	});

	test("edits go both ways", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "one");
		cloud.put(`${VAULT}/b.md`, "two");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.write("a.md", "one, edited on the phone");
		cloud.put(`${VAULT}/b.md`, "two, edited on the desktop");
		p.app.vault.write("New/idea.md", "new on the phone");
		cloud.put(`${VAULT}/from-desktop.md`, "new on the desktop");
		await p.sync();

		assert.equal(cloud.text(`${VAULT}/a.md`), "one, edited on the phone");
		assert.equal(p.app.vault.text("b.md"), "two, edited on the desktop");
		assert.equal(cloud.text(`${VAULT}/New/idea.md`), "new on the phone");
		assert.equal(p.app.vault.text("from-desktop.md"), "new on the desktop");

		await p.sync();
		assert.match(lastRun(p), /0 done/);
	});

	test("deletes propagate and go to the trash", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/keep.md`, "k");
		cloud.put(`${VAULT}/gone-on-phone.md`, "x");
		cloud.put(`${VAULT}/gone-on-desktop.md`, "y");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.remove("gone-on-phone.md");
		cloud.remove(`${VAULT}/gone-on-desktop.md`);
		await p.sync();

		assert.deepEqual(cloud.paths(VAULT), ["keep.md"]);
		assert.deepEqual(p.app.vault.paths(), ["keep.md"]);
		assert.deepEqual(p.app.vault.trashed, ["gone-on-desktop.md"]);
		assert.ok(cloud.trash.includes("gone-on-phone.md"));
	});

	test("an edit wins over a delete", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.remove("a.md");
		cloud.put(`${VAULT}/a.md`, "a, edited on the desktop");
		await p.sync();

		assert.equal(p.app.vault.text("a.md"), "a, edited on the desktop");
	});

	test("a conflict keeps both versions", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "base");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.write("a.md", "phone version");
		cloud.put(`${VAULT}/a.md`, "desktop version, longer");
		await p.sync();

		const copy = p.app.vault.paths().find((x) => x.startsWith("a (conflict "));
		assert.ok(copy, `conflict copy missing: ${p.app.vault.paths().join(", ")}`);
		assert.equal(p.app.vault.text(copy), "desktop version, longer");
		assert.equal(p.app.vault.text("a.md"), "phone version");
		assert.equal(cloud.text(`${VAULT}/a.md`), "phone version");

		await p.sync();
		assert.equal(cloud.text(`${VAULT}/${copy}`), "desktop version, longer", "the copy is uploaded next time");
	});

	test("state survives a restart", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		const p = phone(cloud);
		await p.sync();

		const again = p.restart();
		await again.sync();
		assert.match(lastRun(again), /0 done/);
	});

	test("first sync on a phone that already has a copy adopts equal files", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/same.md`, "same text");
		cloud.put(`${VAULT}/different.md`, "cloud text");
		const p = phone(cloud);
		p.app.vault.write("same.md", "same text");
		p.app.vault.write("different.md", "phone text!");
		await p.sync();

		assert.equal(cloud.text(`${VAULT}/same.md`), "same text");
		assert.ok(p.app.vault.paths().some((x) => x.startsWith("different (conflict ")));
		// only the conflicting file is downloaded; equal files are matched by checksum
		assert.equal(cloud.calls.filter((c) => c === "getfilelink").length, 1);
	});

	test("a folder moved into the vault on the desktop shows up", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		cloud.put("Elsewhere/Archive/old.md", "old");
		const p = phone(cloud);
		await p.sync();

		cloud.moveFolder("Elsewhere/Archive", VAULT);
		await p.sync();
		assert.equal(p.app.vault.text("Archive/old.md"), "old");
	});

	test("mass delete asks first", async () => {
		const cloud = new FakePCloud();
		for (let i = 0; i < 20; i++) cloud.put(`${VAULT}/n${i}.md`, `note ${i}`);
		const p = phone(cloud);
		await p.sync();
		for (let i = 0; i < 15; i++) p.app.vault.remove(`n${i}.md`);
		await p.sync();
		assert.deepEqual(p.asked, [{ count: 15, where: "local" }]);
		assert.equal(cloud.paths(VAULT).length, 5);
	});

	test("keeping files after a mass delete brings them back", async () => {
		const cloud = new FakePCloud();
		for (let i = 0; i < 20; i++) cloud.put(`${VAULT}/n${i}.md`, `note ${i}`);
		const p = phone(cloud);
		await p.sync();
		for (let i = 0; i < 15; i++) cloud.remove(`${VAULT}/n${i}.md`);
		p.allowDeletes = false;
		await p.sync();
		assert.deepEqual(p.asked, [{ count: 15, where: "remote" }]);
		assert.equal(p.app.vault.paths().length, 20);
		assert.equal(cloud.paths(VAULT).length, 20, "restored in pCloud from this device");
	});

	// --- found in review ---

	test("a note created on both sides at once is not overwritten", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.write("daily.md", "phone daily");
		// the desktop saves its own daily note right before our upload
		cloud.before = (method) => {
			if (method === "uploadfile" && !cloud.text(`${VAULT}/daily.md`)) cloud.put(`${VAULT}/daily.md`, "desktop daily, longer");
		};
		await p.sync();
		cloud.before = null;
		await p.sync();
		await p.sync();

		const remote = cloud.paths(VAULT).map((x) => cloud.text(`${VAULT}/${x}`));
		const local = p.app.vault.paths().map((x) => p.app.vault.text(x));
		for (const text of ["phone daily", "desktop daily, longer"]) {
			assert.ok(remote.includes(text), `pCloud lost "${text}": ${cloud.paths(VAULT).join(", ")}`);
			assert.ok(local.includes(text), `phone lost "${text}": ${p.app.vault.paths().join(", ")}`);
		}
	});

	test("deleting a file that was moved meanwhile leaves it alone", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		cloud.put(`${VAULT}/keep.md`, "k");
		const p = phone(cloud);
		await p.sync();

		p.app.vault.remove("a.md");
		cloud.before = (method) => {
			if (method === "stat" && cloud.text(`${VAULT}/a.md`)) cloud.moveFile(`${VAULT}/a.md`, `${VAULT}/Archive`);
		};
		await p.sync();
		cloud.before = null;
		assert.equal(cloud.text(`${VAULT}/Archive/a.md`), "a", "the moved file survives in pCloud");
		await p.sync();
		assert.equal(p.app.vault.text("Archive/a.md"), "a");
	});

	test("switching folders after an interrupted first sync deletes nothing", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		cloud.put(`${VAULT}/b.md`, "b");
		const p = phone(cloud);
		await p.sync();
		// app killed before the snapshot was written: only the journal is left
		const store = p.app.vault.adapter.store;
		for (const k of [...store.keys()]) if (k.includes("state-")) store.delete(k);

		const again = p.restart();
		cloud.mkdirs("Other/Empty");
		again.useFolder("Other/Empty");
		await again.sync();
		assert.deepEqual(p.app.vault.trashed, []);
		assert.deepEqual(p.app.vault.paths(), ["a.md", "b.md"]);
		assert.deepEqual(cloud.paths("Other/Empty"), ["a.md", "b.md"]);
	});

	test("a folder moved in while listing it fails is not deleted locally", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		cloud.put(`${VAULT}/Box/x.md`, "x");
		const p = phone(cloud);
		await p.sync();

		cloud.moveFolder(`${VAULT}/Box`, "Elsewhere");
		cloud.moveFolder("Elsewhere/Box", VAULT);
		cloud.before = (method, q) => {
			if (method === "listfolder" && q.get("folderid") === String(cloud.mkdirs(`${VAULT}/Box`))) {
				throw new Error("network down");
			}
		};
		assert.equal(await p.trySync(), "offline");
		cloud.before = null;
		await p.sync();
		assert.equal(p.app.vault.text("Box/x.md"), "x");
		assert.deepEqual(p.app.vault.trashed, []);
	});

	test("going offline mid-sync stops at once and keeps the edits queued", async () => {
		const cloud = new FakePCloud();
		for (let i = 0; i < 5; i++) cloud.put(`${VAULT}/n${i}.md`, `${i}`);
		const p = phone(cloud);
		await p.sync();

		for (let i = 0; i < 5; i++) p.app.vault.write(`n${i}.md`, `${i} edited`);
		let calls = 0;
		cloud.before = (method) => {
			if (method === "uploadfile" && ++calls > 1) throw new Error("network down");
		};
		assert.equal(await p.trySync(), "offline");
		assert.ok(calls <= 5, `kept retrying offline: ${calls} upload attempts`);
		cloud.before = null;
		await p.sync();
		for (let i = 0; i < 5; i++) assert.equal(cloud.text(`${VAULT}/n${i}.md`), `${i} edited`);
	});

	test("dot files in pCloud are ignored", async () => {
		const cloud = new FakePCloud();
		cloud.put(`${VAULT}/a.md`, "a");
		cloud.put(`${VAULT}/.gitignore`, "node_modules");
		cloud.put(`${VAULT}/.github/ci.yml`, "x");
		const p = phone(cloud);
		await p.sync();
		await p.sync();
		assert.deepEqual(p.app.vault.paths(), ["a.md"]);
	});
});
