import { debounce, Notice, Platform, Plugin, type TAbstractFile } from "obsidian";
import { AuthManager } from "./auth";
import { PROTOCOL_ACTION } from "./config";
import { loadCore } from "./core";
import { Device, type RemoteFolder, vaultInsidePCloudDrive } from "./device";
import { Log } from "./log";
import { obsidianTransport } from "./pcloud/obsidian-transport";
import { CumulusSettingTab } from "./settings";
import { type SyncReason, type SyncStatus, SyncController } from "./sync/controller";
import { LocalVault } from "./sync/local";
import { StateStore } from "./sync/state";
import { DeleteModal, FolderPickerModal, LogModal } from "./ui/modals";
import { StatusBar } from "./ui/statusbar";

const EDIT_DELAY_MS = 15_000;
const RESUME_MIN_GAP_MS = 30_000;
const INTERVAL_MS = 5 * 60_000;

export default class CumulusPlugin extends Plugin {
	auth!: AuthManager;
	device!: Device;
	private controller!: SyncController;
	private log = new Log();
	private tab!: CumulusSettingTab;
	private lastState: SyncStatus["state"] = "idle";
	private lastError = "";

	async onload(): Promise<void> {
		await loadCore();
		this.device = new Device(this.app);
		this.auth = new AuthManager(this.app, obsidianTransport, this.device.id);

		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const statusBar = Platform.isMobile ? null : new StatusBar(this.addStatusBarItem(), () => this.sync("manual"));
		this.controller = new SyncController(
			this.app,
			this.auth,
			this.device,
			new StateStore(this.app.vault.adapter, dir),
			new LocalVault(this.app),
			this.log,
			(count, where) => DeleteModal.ask(this.app, count, where),
			(s) => {
				statusBar?.render(s);
				this.notify(s);
			},
		);
		statusBar?.render(this.controller.current);

		this.tab = new CumulusSettingTab(this.app, this, this);
		this.addSettingTab(this.tab);
		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.finishSignIn(params));

		this.addRibbonIcon("refresh-cw", "Sync with pCloud", () => this.sync("manual"));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync("manual") });
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.log).open() });

		this.app.workspace.onLayoutReady(() => {
			// Registered here so the burst of create events at startup is not seen as edits.
			const edited = debounce(() => this.sync("edit"), EDIT_DELAY_MS, true);
			const onChange = (file: TAbstractFile, oldPath?: string) => {
				const changed = this.controller.markDirty(file.path);
				const moved = oldPath ? this.controller.markDirty(oldPath) : false;
				if (changed || moved) edited();
			};
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));

			this.registerDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "hidden") {
					if (this.controller.hasDirty) this.sync("leave");
				} else if (Date.now() - (this.controller.current.lastSync ?? 0) > RESUME_MIN_GAP_MS) {
					this.sync("resume");
				}
			});
			this.registerInterval(window.setInterval(() => this.sync("interval"), INTERVAL_MS));
			this.sync("startup");
		});
	}

	async onunload(): Promise<void> {
		// an update through BRAT loads the new copy while this one may still be syncing
		await this.controller?.stop();
	}

	pickFolder(onPicked: (folder: RemoteFolder) => void): Promise<void> {
		const client = this.auth.client();
		if (!client || vaultInsidePCloudDrive(this.app)) return Promise.resolve();
		return FolderPickerModal.open(this.app, client, (folder) => {
			this.device.update({ folder });
			this.log.info(`vault folder set to ${folder.path}`);
			onPicked(folder);
			this.sync("manual");
		});
	}

	private sync(reason: SyncReason): void {
		void this.controller.sync(reason);
	}

	private async finishSignIn(params: Record<string, string>): Promise<void> {
		try {
			this.tab.connected(await this.auth.completeOAuth(params));
		} catch (e) {
			new Notice(`Couldn't sign in to pCloud: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Mobile has no status bar, so problems and doubled notes surface as notices. */
	private notify(s: SyncStatus): void {
		const entered = s.state !== this.lastState;
		this.lastState = s.state;
		if (!entered) return;
		if (s.state === "error" && s.message !== this.lastError) new Notice(`Sync: ${s.message}`, 8000);
		if (s.state === "error") this.lastError = s.message;
		if (s.state === "idle") this.lastError = "";
		if (s.state === "idle" && s.conflicts.length) {
			const names = s.conflicts.map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, ""));
			const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
			new Notice(`${list} changed on two devices at once. Both versions are kept side by side.`, 10000);
		}
	}
}
