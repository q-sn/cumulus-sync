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

const VAULT = "Notes/Vault";

interface Phone {
	app: FakeApp;
	log: Log;
	/** Mass-delete questions asked so far. */
	asked: { count: number; where: DeletedWhere }[];
	/** Answer to the next mass-delete question: delete (true) or keep the files. */
	allowDeletes: boolean;
	sync(): Promise<void>;
	restart(): Phone;
}

function phone(cloud: FakePCloud, app = new FakeApp()): Phone {
	app.secrets.set("cumulus-pcloud-token", "test-token");
	app.local.set("cumulus-pcloud-host", "eapi.pcloud.com");
	const device = new Device(app as unknown as App);
	device.update({ folder: { id: String(cloud.mkdirs(VAULT)), path: `/${VAULT}` } });
	const log = new Log();
	const asked: Phone["asked"] = [];
	const controller = new SyncController(
		app as unknown as App,
		new AuthManager(app as unknown as App, cloud.transport),
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
		assert.deepEqual(p.app.vault.trash, ["gone-on-desktop.md"]);
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
});
