import { setIcon } from "obsidian";
import type { SyncStatus } from "../sync/controller";

const ICONS: Record<SyncStatus["state"], string> = {
	idle: "cloud",
	syncing: "refresh-cw",
	offline: "cloud-off",
	error: "alert-triangle",
	setup: "cloud",
};

export class StatusBar {
	private icon: HTMLElement;
	private text: HTMLElement;

	constructor(
		private readonly el: HTMLElement,
		onClick: () => void,
	) {
		el.addClass("cumulus-status", "mod-clickable");
		this.icon = el.createSpan({ cls: "cumulus-status-icon" });
		this.text = el.createSpan();
		el.addEventListener("click", onClick);
	}

	render(s: SyncStatus): void {
		setIcon(this.icon, ICONS[s.state]);
		this.el.toggleClass("is-syncing", s.state === "syncing");
		this.text.setText(label(s));
		this.el.setAttribute("aria-label", s.message || label(s));
	}
}

function label(s: SyncStatus): string {
	switch (s.state) {
		case "syncing":
			return s.progress && s.progress.total > 0 ? `${s.progress.done}/${s.progress.total}` : "Syncing";
		case "offline":
			return "Offline";
		case "error":
			return "Sync error";
		case "setup":
			return "Not set up";
		case "idle":
			return s.lastSync ? `Synced ${time(s.lastSync)}` : "Cumulus";
	}
}

function time(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
