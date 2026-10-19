import { type App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { RemoteFolder } from "../device";
import type { Log } from "../log";
import type { PCloudClient } from "../pcloud/client";
import type { RemoteMetadata } from "../pcloud/types";
import type { DeletedWhere } from "../sync/controller";

const DELETE_TEXT: Record<DeletedWhere, (n: number) => string> = {
	local: (n) => `${n} files were deleted on this device. Delete them from pCloud too?`,
	remote: (n) => `${n} files were deleted in pCloud. Delete them on this device too?`,
	both: (n) => `${n} files were deleted. Delete them everywhere?`,
};

export class DeleteModal extends Modal {
	private answer = false;

	private constructor(
		app: App,
		private readonly count: number,
		private readonly where: DeletedWhere,
		private readonly resolve: (remove: boolean) => void,
	) {
		super(app);
	}

	static ask(app: App, count: number, where: DeletedWhere): Promise<boolean> {
		return new Promise((resolve) => new DeleteModal(app, count, where, resolve).open());
	}

	onOpen(): void {
		this.setTitle(`Delete ${this.count} files?`);
		this.contentEl.createEl("p", { text: DELETE_TEXT[this.where](this.count) });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Keep files").setCta().onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => {
						this.answer = true;
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing without choosing keeps the files.
		this.resolve(this.answer);
	}
}

interface Level {
	id: string;
	name: string;
	folders: RemoteMetadata[];
}

export class FolderPickerModal extends Modal {
	private stack: Level[];
	private cache = new Map<string, RemoteMetadata[]>();
	private crumbs!: HTMLElement;
	private list!: HTMLElement;
	private useButton!: HTMLButtonElement;
	private busy = false;

	private constructor(
		app: App,
		private readonly client: PCloudClient,
		root: RemoteMetadata[],
		private readonly onPick: (folder: RemoteFolder) => void,
	) {
		super(app);
		this.stack = [{ id: "0", name: "pCloud", folders: root }];
		this.cache.set("0", root);
	}

	/** Loads the top level first, so the dialog opens with content instead of filling in. */
	static async open(app: App, client: PCloudClient, onPick: (folder: RemoteFolder) => void): Promise<void> {
		try {
			const root = folders(await client.listFolder("0"));
			new FolderPickerModal(app, client, root, onPick).open();
		} catch (e) {
			new Notice(`Couldn't open pCloud: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onOpen(): void {
		this.setTitle("Choose your vault folder");
		this.modalEl.addClass("cumulus-picker");
		this.crumbs = this.contentEl.createDiv({ cls: "cumulus-picker-path" });
		this.list = this.contentEl.createDiv({ cls: "cumulus-picker-list" });
		const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
		this.useButton = footer.createEl("button", { text: "Use this folder", cls: "mod-cta" });
		this.useButton.addEventListener("click", () => this.pick());
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private get here(): Level {
		return this.stack[this.stack.length - 1] as Level;
	}

	private render(): void {
		this.crumbs.empty();
		this.stack.forEach((level, i) => {
			if (i > 0) this.crumbs.createSpan({ text: " / ", cls: "cumulus-picker-sep" });
			const crumb = this.crumbs.createSpan({ text: level.name, cls: "cumulus-picker-crumb" });
			if (i < this.stack.length - 1) crumb.addEventListener("click", () => this.goTo(i));
			else crumb.addClass("is-current");
		});

		const rows = this.here.folders.map((f) => {
			const row = createDiv({ cls: "cumulus-picker-row" });
			setIcon(row.createSpan({ cls: "cumulus-picker-icon" }), "folder");
			row.createSpan({ text: f.name });
			row.addEventListener("click", () => void this.enter(f));
			return row;
		});
		if (rows.length === 0) rows.push(createDiv({ text: "No folders here", cls: "cumulus-picker-empty" }));
		this.list.replaceChildren(...rows);
		this.list.scrollTop = 0;
		this.useButton.disabled = this.stack.length === 1;
	}

	private async enter(f: RemoteMetadata): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.list.addClass("is-loading");
		try {
			let children = this.cache.get(f.id);
			if (!children) {
				children = folders(await this.client.listFolder(f.id));
				this.cache.set(f.id, children);
			}
			this.stack.push({ id: f.id, name: f.name, folders: children });
			this.render();
		} catch (e) {
			new Notice(`Couldn't open ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busy = false;
			this.list.removeClass("is-loading");
		}
	}

	private goTo(index: number): void {
		if (this.busy) return;
		this.stack = this.stack.slice(0, index + 1);
		this.render();
	}

	private pick(): void {
		if (this.stack.length === 1) return;
		const path = `/${this.stack
			.slice(1)
			.map((l) => l.name)
			.join("/")}`;
		this.onPick({ id: this.here.id, path });
		this.close();
	}
}

function folders(listing: RemoteMetadata): RemoteMetadata[] {
	return (listing.contents ?? []).filter((m) => m.isFolder).sort((a, b) => a.name.localeCompare(b.name));
}

export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly log: Log,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Sync log");
		const entries = [...this.log.all()].reverse();
		if (entries.length === 0) {
			this.contentEl.createEl("p", { text: "Nothing yet." });
			return;
		}
		const pre = this.contentEl.createEl("pre", { cls: "cumulus-log" });
		pre.setText(
			entries.map((e) => `${new Date(e.time).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.message}`).join("\n"),
		);
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Copy").onClick(async () => {
				await navigator.clipboard.writeText(pre.getText());
				new Notice("Copied");
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
