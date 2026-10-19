import { debounce, Notice, Platform, Plugin, type TAbstractFile } from "obsidian";
import { AuthManager } from "./auth";
import { PROTOCOL_ACTION } from "./config";
import { loadCore } from "./core";
import { Device, vaultInsidePCloudDrive } from "./device";
import { Log } from "./log";
import { obsidianTransport } from "./pcloud/obsidian-transport";
import { CumulusSettingTab } from "./settings";
import { type CumulusSettings, DEFAULT_SETTINGS } from "./settings-data";
import { type SyncReason, type SyncStatus, SyncController } from "./sync/controller";
import { LocalVault } from "./sync/local";
import { StateStore } from "./sync/state";
import { FolderPickerModal, LogModal, PlanModal } from "./ui/modals";
import { StatusBar } from "./ui/statusbar";

const EDIT_DELAY_MS = 15_000;
const RESUME_MIN_GAP_MS = 30_000;

export default class CumulusPlugin extends Plugin {
	auth!: AuthManager;
	device!: Device;
	settings!: CumulusSettings;
	controller!: SyncController;
	private log = new Log();
	private tab!: CumulusSettingTab;
	private lastState: SyncStatus["state"] = "idle";
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		await loadCore();
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CumulusSettings> | null) };
		this.auth = new AuthManager(this.app, obsidianTransport);
		this.device = new Device(this.app);

		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const statusBar = Platform.isMobile ? null : new StatusBar(this.addStatusBarItem(), () => this.syncNow());
		this.controller = new SyncController(
			this.app,
			this.auth,
			this.device,
			new StateStore(this.app.vault.adapter, dir),
			new LocalVault(this.app),
			this.log,
			() => this.settings,
			(plan, mode) => PlanModal.ask(this.app, plan, mode),
			(s) => {
				statusBar?.render(s);
				this.notify(s);
			},
		);
		statusBar?.render(this.controller.current);

		this.tab = new CumulusSettingTab(this.app, this, this);
		this.addSettingTab(this.tab);
		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.finishOAuth(params));

		this.addRibbonIcon("refresh-cw", "Sync with pCloud", () => this.syncNow());
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
		this.addCommand({ id: "preview-sync", name: "Preview sync", callback: () => this.auto("preview", true) });
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });

		this.app.workspace.onLayoutReady(() => {
			// Registered here so the burst of create events at startup is not seen as edits.
			const edited = debounce(() => this.auto("edit"), EDIT_DELAY_MS, true);
			const onChange = (file: TAbstractFile, oldPath?: string) => {
				this.controller.markDirty(file.path);
				if (oldPath) this.controller.markDirty(oldPath);
				edited();
			};
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));

			this.registerDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "hidden") {
					if (this.controller.hasDirty) this.auto("leave");
				} else {
					const last = this.controller.current.lastSync ?? 0;
					if (Date.now() - last > RESUME_MIN_GAP_MS) this.auto("resume");
				}
			});
			this.restartInterval();
			this.auto("startup");
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.restartInterval();
	}

	pickFolder(): void {
		const client = this.auth.client();
		if (!client || vaultInsidePCloudDrive(this.app)) return;
		new FolderPickerModal(this.app, client, (folder) => {
			this.device.update({ folder, paused: false });
			this.log.info(`vault folder set to ${folder.path}`);
			this.tab.display();
			// first sync shows its preview before touching anything
			void this.controller.sync("manual");
		}).open();
	}

	showLog(): void {
		new LogModal(this.app, this.log).open();
	}

	private syncNow(): void {
		this.auto("manual", true);
	}

	private auto(reason: SyncReason, explicit = false): void {
		if (!explicit && !this.settings.autoSync) return;
		void this.controller.sync(reason);
	}

	private restartInterval(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = this.registerInterval(
			window.setInterval(() => this.auto("interval"), this.settings.intervalMinutes * 60_000),
		);
	}

	private async finishOAuth(params: Record<string, string>): Promise<void> {
		try {
			const info = await this.auth.completeOAuth(params);
			new Notice(`Cumulus: connected as ${info.email}`);
			this.tab.setAccount(info);
		} catch (e) {
			new Notice(`Cumulus: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Mobile has no status bar, so problems and conflicts surface as notices. */
	private notify(s: SyncStatus): void {
		const entered = s.state !== this.lastState;
		this.lastState = s.state;
		if (!entered) return;
		if (s.state === "error") new Notice(`Cumulus: ${s.message}`, 8000);
		if (s.state === "idle" && s.conflicts.length) {
			new Notice(`Cumulus: ${s.conflicts.length} conflict(s). Both versions were kept, see the sync log.`, 8000);
		}
	}
}
