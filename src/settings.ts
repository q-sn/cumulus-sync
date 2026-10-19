import { type App, FileSystemAdapter, Notice, Platform, type Plugin, PluginSettingTab, Setting } from "obsidian";
import type { AuthManager } from "./auth";
import { defaultDeviceName, type Device } from "./device";
import type { UserInfo } from "./pcloud/types";
import type { CumulusSettings } from "./settings-data";
import type { SyncController } from "./sync/controller";

const GB = 1024 ** 3;

export interface SettingsHost {
	auth: AuthManager;
	device: Device;
	settings: CumulusSettings;
	controller: SyncController;
	saveSettings(): Promise<void>;
	pickFolder(): void;
	showLog(): void;
}

export class CumulusSettingTab extends PluginSettingTab {
	private account: UserInfo | null = null;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.accountSection(containerEl);
		if (!this.host.auth.client()) return;
		this.deviceSection(containerEl);
		this.syncSection(containerEl);
		this.maintenanceSection(containerEl);
	}

	setAccount(info: UserInfo): void {
		this.account = info;
		this.display();
	}

	private accountSection(el: HTMLElement): void {
		const { auth } = this.host;
		new Setting(el).setName("pCloud account").setHeading();
		const client = auth.client();

		if (client) {
			const status = new Setting(el)
				.setName("Connected")
				.setDesc("Checking account…")
				.addButton((b) =>
					b
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await auth.disconnect();
							this.account = null;
							new Notice("Cumulus: disconnected from pCloud");
							this.display();
						}),
				);
			const describe = (info: UserInfo) =>
				status.setDesc(
					`${info.email} · ${(info.usedQuota / GB).toFixed(1)} of ${(info.quota / GB).toFixed(0)} GB used`,
				);
			if (this.account) describe(this.account);
			else
				client
					.userInfo()
					.then((info) => {
						this.account = info;
						describe(info);
					})
					.catch((e: unknown) => status.setDesc(`Cannot reach pCloud: ${message(e)}`));
			return;
		}

		if (auth.canUseOAuth) {
			new Setting(el)
				.setName("Connect to pCloud")
				.setDesc("Opens pCloud in your browser to grant access.")
				.addButton((b) => b.setButtonText("Connect").setCta().onClick(() => auth.startOAuth()));
		}

		let code = "";
		new Setting(el)
			.setName("Paste sign-in code")
			.setDesc("If the browser did not return to Obsidian, paste the code shown on the sign-in page.")
			.addText((t) => t.setPlaceholder("cumulus1:…").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Connect").onClick(async () => {
					try {
						this.account = await auth.connectWithCode(code);
						new Notice(`Cumulus: connected as ${this.account.email}`);
						this.display();
					} catch (e) {
						new Notice(`Cumulus: ${message(e)}`);
					}
				}),
			);
	}

	private deviceSection(el: HTMLElement): void {
		const { device, settings } = this.host;
		new Setting(el).setName("This device").setHeading();

		new Setting(el)
			.setName("Vault folder in pCloud")
			.setDesc(device.folder ? device.folder.path : "Not chosen yet")
			.addButton((b) => b.setButtonText(device.folder ? "Change" : "Choose").onClick(() => this.host.pickFolder()));

		const insideDrive = vaultInsidePCloudDrive(this.app);
		const enable = new Setting(el)
			.setName("Sync this vault")
			.setDesc(
				insideDrive
					? "This vault seems to be inside pCloud Drive, which already syncs it. Turning Cumulus on here would sync the folder with itself."
					: "Turn on once the folder above is right. The first sync shows a preview before changing anything.",
			)
			.addToggle((t) =>
				t
					.setValue(device.enabled)
					.setDisabled(!device.folder)
					.onChange((on) => {
						device.update({ enabled: on });
						if (on) void this.host.controller.sync("manual");
					}),
			);
		if (insideDrive) enable.descEl.addClass("mod-warning");

		new Setting(el)
			.setName("Device name")
			.setDesc("Used in the names of conflict copies made on this device.")
			.addText((t) =>
				t
					.setPlaceholder(defaultDeviceName())
					.setValue(settings.deviceName)
					.onChange(async (v) => {
						settings.deviceName = v.trim();
						await this.host.saveSettings();
					}),
			);
	}

	private syncSection(el: HTMLElement): void {
		const { settings } = this.host;
		new Setting(el).setName("Sync").setHeading();

		new Setting(el)
			.setName("Sync automatically")
			.setDesc("When Obsidian opens, when you come back to it, shortly after edits and when you switch away.")
			.addToggle((t) =>
				t.setValue(settings.autoSync).onChange(async (v) => {
					settings.autoSync = v;
					await this.host.saveSettings();
				}),
			);

		new Setting(el)
			.setName("Sync every")
			.setDesc("Minutes between syncs while Obsidian is open.")
			.addDropdown((d) => {
				for (const m of [1, 2, 5, 10, 15, 30, 60]) d.addOption(String(m), `${m} min`);
				d.setValue(String(settings.intervalMinutes)).onChange(async (v) => {
					settings.intervalMinutes = Number(v);
					await this.host.saveSettings();
				});
			});

		new Setting(el)
			.setName("Largest file to sync, MB")
			.setDesc(`Bigger files are skipped. Leave empty for the default (${Platform.isMobileApp ? 25 : 200} MB here).`)
			.addText((t) =>
				t
					.setPlaceholder(String(Platform.isMobileApp ? 25 : 200))
					.setValue(settings.maxFileSizeMb === null ? "" : String(settings.maxFileSizeMb))
					.onChange(async (v) => {
						const n = Number(v);
						settings.maxFileSizeMb = v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
						await this.host.saveSettings();
					}),
			);

		new Setting(el)
			.setName("Don't sync")
			.setDesc("One pattern per line, like .gitignore: Private/**, *.mp4, drafts/*.")
			.addTextArea((t) =>
				t.setValue(settings.exclude.join("\n")).onChange(async (v) => {
					settings.exclude = v
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);
					await this.host.saveSettings();
				}),
			);
	}

	private maintenanceSection(el: HTMLElement): void {
		const { controller } = this.host;
		new Setting(el).setName("Troubleshooting").setHeading();

		new Setting(el)
			.setName("Preview sync")
			.setDesc("See what the next sync would do, then run it or cancel.")
			.addButton((b) => b.setButtonText("Preview").onClick(() => void controller.sync("preview")));

		new Setting(el).setName("Sync log").addButton((b) => b.setButtonText("Show").onClick(() => this.host.showLog()));

		new Setting(el)
			.setName("Forget sync history")
			.setDesc(
				"Treat the next sync as a first sync. Nothing is deleted, but files you deleted earlier may come back from pCloud.",
			)
			.addButton((b) =>
				b
					.setButtonText("Forget")
					.setWarning()
					.onClick(async () => {
						await controller.resetState();
						new Notice("Cumulus: sync history cleared");
					}),
			);
	}
}

function vaultInsidePCloudDrive(app: App): boolean {
	const adapter = app.vault.adapter;
	if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return false;
	const base = adapter.getBasePath();
	return /pcloud ?drive/i.test(base) || /^p:[\\/]/i.test(base);
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
