import { type App, Modal, Notice, Setting } from "obsidian";
import type { Log } from "../log";
import type { PCloudClient } from "../pcloud/client";
import type { RemoteMetadata } from "../pcloud/types";
import type { RemoteFolder } from "../device";
import type { Action, FirstSync, Plan } from "../sync/types";

const LABELS: Record<Action["kind"], string> = {
	upload: "Upload",
	download: "Download",
	conflict: "Conflict",
	deleteLocal: "Delete on this device",
	deleteRemote: "Delete in pCloud",
	renameLocal: "Rename on this device",
	renameRemote: "Rename in pCloud",
	adopt: "Already the same",
	forget: "Stop tracking",
};

const FIRST_SYNC: Record<FirstSync, { name: string; desc: string }> = {
	merge: {
		name: "Merge",
		desc: "Keep files from both sides. Files that differ are kept twice, as conflict copies.",
	},
	preferRemote: {
		name: "pCloud wins",
		desc: "Use the pCloud version where both sides have the file. Best for a new phone or tablet.",
	},
	preferLocal: {
		name: "This device wins",
		desc: "Use the version on this device where both sides have the file.",
	},
};

const SHOWN = 200;

export class PlanModal extends Modal {
	private choice: FirstSync | null = null;

	constructor(
		app: App,
		private readonly plan: Plan,
		private mode: FirstSync,
		private readonly resolve: (mode: FirstSync | null) => void,
	) {
		super(app);
	}

	static ask(app: App, plan: Plan, mode: FirstSync): Promise<FirstSync | null> {
		return new Promise((resolve) => new PlanModal(app, plan, mode, resolve).open());
	}

	onOpen(): void {
		const { contentEl } = this;
		const { actions, guard, warnings } = this.plan;
		const first = guard?.kind === "firstSync";
		this.setTitle(first ? "First sync with pCloud" : guard ? "Confirm sync" : "Sync preview");

		if (guard?.kind === "massDelete") {
			contentEl.createEl("p", {
				text: `This sync would delete ${guard.count} files. That usually means a folder was removed or moved. Check the list before going on.`,
				cls: "mod-warning",
			});
		}
		if (first) {
			contentEl.createEl("p", { text: "Here is what happens when this device and pCloud are joined for the first time." });
			new Setting(contentEl)
				.setName("When a file exists on both sides")
				.setDesc(FIRST_SYNC[this.mode].desc)
				.addDropdown((d) => {
					for (const [key, v] of Object.entries(FIRST_SYNC)) d.addOption(key, v.name);
					d.setValue(this.mode).onChange((v) => {
						// Re-planning happens in the controller; close and come back with the new plan.
						this.choice = v as FirstSync;
						this.close();
					});
				});
		}

		const counts = new Map<Action["kind"], number>();
		for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
		const summary = contentEl.createEl("ul");
		if (actions.length === 0) summary.createEl("li", { text: "Nothing to do, everything is in sync." });
		for (const [kind, n] of counts) {
			if (kind !== "adopt" && kind !== "forget") summary.createEl("li", { text: `${LABELS[kind]}: ${n}` });
		}
		if (warnings.length) summary.createEl("li", { text: `Not synced, see log: ${warnings.length}` });

		const visible = actions.filter((a) => a.kind !== "adopt" && a.kind !== "forget");
		if (visible.length) {
			const details = contentEl.createEl("details");
			details.createEl("summary", { text: "Files" });
			const list = details.createEl("ul", { cls: "cumulus-plan-list" });
			for (const a of visible.slice(0, SHOWN)) {
				list.createEl("li", { text: `${LABELS[a.kind]}: ${"path" in a ? a.path : `${a.from} → ${a.to}`}` });
			}
			if (visible.length > SHOWN) list.createEl("li", { text: `and ${visible.length - SHOWN} more` });
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(actions.length ? "Sync" : "Done")
					.setCta()
					.onClick(() => {
						this.choice = this.mode;
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.choice);
	}
}

export class FolderPickerModal extends Modal {
	private stack: { id: string; name: string }[] = [{ id: "0", name: "pCloud" }];

	constructor(
		app: App,
		private readonly client: PCloudClient,
		private readonly onPick: (folder: RemoteFolder) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Choose your vault folder in pCloud");
		void this.render();
	}

	private get path(): string {
		return this.stack
			.slice(1)
			.map((f) => f.name)
			.join("/");
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const here = this.stack[this.stack.length - 1];
		if (!here) return;
		contentEl.createEl("p", { text: `/${this.path}` });

		let folder: RemoteMetadata;
		try {
			folder = await this.client.listFolder(here.id);
		} catch (e) {
			contentEl.createEl("p", { text: `Cannot list this folder: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		const items = folder.contents ?? [];
		const subfolders = items.filter((m) => m.isFolder).sort((a, b) => a.name.localeCompare(b.name));
		const looksLikeVault = items.some((m) => m.isFolder && m.name === this.app.vault.configDir);

		if (this.stack.length > 1) {
			new Setting(contentEl).setName("..").addButton((b) =>
				b.setButtonText("Up").onClick(() => {
					this.stack.pop();
					void this.render();
				}),
			);
		}
		for (const f of subfolders) {
			new Setting(contentEl).setName(f.name).addButton((b) =>
				b.setButtonText("Open").onClick(() => {
					this.stack.push({ id: f.id, name: f.name });
					void this.render();
				}),
			);
		}
		if (subfolders.length === 0) contentEl.createEl("p", { text: "No subfolders." });

		const pick = new Setting(contentEl)
			.setName(this.stack.length === 1 ? "The root of pCloud can't be used" : `Use /${this.path}`)
			.setDesc(
				looksLikeVault
					? "This folder contains an Obsidian vault."
					: `${items.length} items. No ${this.app.vault.configDir} folder here, so it may not be a vault.`,
			);
		if (this.stack.length > 1) {
			pick.addButton((b) =>
				b
					.setButtonText("Use this folder")
					.setCta()
					.onClick(() => {
						this.onPick({ id: here.id, path: `/${this.path}` });
						this.close();
					}),
			);
		}
	}
}

export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly log: Log,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Cumulus sync log");
		const entries = [...this.log.all()].reverse();
		if (entries.length === 0) {
			this.contentEl.createEl("p", { text: "Nothing logged yet." });
			return;
		}
		const pre = this.contentEl.createEl("pre", { cls: "cumulus-log" });
		pre.setText(
			entries
				.map((e) => `${new Date(e.time).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.message}`)
				.join("\n"),
		);
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Copy").onClick(async () => {
				await navigator.clipboard.writeText(pre.getText());
				new Notice("Log copied");
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
