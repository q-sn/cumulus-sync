import { type App, Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";
import type { AuthManager } from "./auth";
import { type Device, type RemoteFolder, vaultInsidePCloudDrive } from "./device";
import type { UserInfo } from "./pcloud/types";

export interface SettingsHost {
	auth: AuthManager;
	device: Device;
	/** Resolves once the picker is on screen. */
	pickFolder(onPicked: (folder: RemoteFolder) => void): Promise<void>;
}

export class CumulusSettingTab extends PluginSettingTab {
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
		if (this.host.auth.client()) {
			this.account(containerEl);
			this.folder(containerEl);
		} else {
			this.connect(containerEl);
		}
	}

	/** After the obsidian:// sign-in callback. */
	connected(info: UserInfo): void {
		this.host.device.update({ email: info.email });
		this.display();
	}

	private account(el: HTMLElement): void {
		const { auth, device } = this.host;
		const row = new Setting(el)
			.setName("pCloud account")
			.setDesc(device.email ?? "Connected")
			.addButton((b) =>
				b.setButtonText("Disconnect").onClick(async () => {
					await auth.disconnect();
					device.update({ email: null, folder: null });
					this.display();
				}),
			);
		// Refresh quietly; the cached email is already on screen.
		auth.client()
			?.userInfo()
			.then((info) => {
				if (info.email !== device.email) {
					device.update({ email: info.email });
					row.setDesc(info.email);
				}
			})
			.catch(() => undefined);
	}

	private folder(el: HTMLElement): void {
		const { device } = this.host;
		const insideDrive = vaultInsidePCloudDrive(this.app);
		const row = new Setting(el).setName("Vault folder in pCloud");
		const describe = (folder: RemoteFolder | null) => {
			if (insideDrive) row.setDesc("This vault is already synced by pCloud Drive, so Cumulus isn't needed here.");
			else row.setDesc(folder ? folder.path : "Pick the folder that holds your vault.");
		};
		describe(device.folder);
		row.addButton((b) => {
			b.setButtonText(device.folder ? "Change" : "Choose").setDisabled(insideDrive);
			if (!device.folder && !insideDrive) b.setCta();
			b.onClick(async () => {
				b.setDisabled(true);
				await this.host.pickFolder((folder) => {
					describe(folder);
					b.setButtonText("Change").removeCta();
				});
				b.setDisabled(false);
			});
		});
	}

	private connect(el: HTMLElement): void {
		const { auth } = this.host;
		if (auth.canUseOAuth) {
			new Setting(el)
				.setName("pCloud account")
				.setDesc("Sign in to pCloud to start syncing this vault.")
				.addButton((b) => b.setButtonText("Connect").setCta().onClick(() => auth.startOAuth()));
		}

		let code = "";
		new Setting(el)
			.setName(auth.canUseOAuth ? "Sign-in code" : "pCloud account")
			.setDesc(
				auth.canUseOAuth
					? "If the browser didn't bring you back to Obsidian, paste the code from the sign-in page."
					: "Paste your pCloud sign-in code.",
			)
			.addText((t) => t.setPlaceholder("cumulus1:…").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Connect").onClick(async () => {
					b.setDisabled(true);
					try {
						this.connected(await auth.connectWithCode(code));
					} catch (e) {
						new Notice(`Couldn't sign in: ${e instanceof Error ? e.message : String(e)}`);
						b.setDisabled(false);
					}
				}),
			);
	}
}
