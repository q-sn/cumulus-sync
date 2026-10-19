import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { AuthManager } from "./auth";
import type { UserInfo } from "./pcloud/types";

const GB = 1024 ** 3;

export class CumulusSettingTab extends PluginSettingTab {
	private account: UserInfo | null = null;

	constructor(
		app: App,
		plugin: ConstructorParameters<typeof PluginSettingTab>[1],
		private readonly auth: AuthManager,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("pCloud account").setHeading();
		const client = this.auth.client();

		if (client) {
			const status = new Setting(containerEl)
				.setName("Connected")
				.setDesc("Checking account…")
				.addButton((b) =>
					b
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.auth.disconnect();
							this.account = null;
							new Notice("Cumulus: disconnected from pCloud");
							this.display();
						}),
				);
			const describe = (info: UserInfo) =>
				status.setDesc(
					`${info.email} · ${(info.usedQuota / GB).toFixed(1)} of ${(info.quota / GB).toFixed(0)} GB used`,
				);
			if (this.account) {
				describe(this.account);
			} else {
				client
					.userInfo()
					.then((info) => {
						this.account = info;
						describe(info);
					})
					.catch((e: unknown) => status.setDesc(`Cannot reach pCloud: ${message(e)}`));
			}
			return;
		}

		if (this.auth.canUseOAuth) {
			new Setting(containerEl)
				.setName("Connect to pCloud")
				.setDesc("Opens pCloud in your browser to grant access.")
				.addButton((b) => b.setButtonText("Connect").setCta().onClick(() => this.auth.startOAuth()));
		}

		let code = "";
		new Setting(containerEl)
			.setName("Paste sign-in code")
			.setDesc("If the browser did not return to Obsidian, paste the code shown on the sign-in page.")
			.addText((t) => t.setPlaceholder("cumulus1:…").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Connect").onClick(async () => {
					try {
						this.account = await this.auth.connectWithCode(code);
						new Notice(`Cumulus: connected as ${this.account.email}`);
						this.display();
					} catch (e) {
						new Notice(`Cumulus: ${message(e)}`);
					}
				}),
			);
	}

	setAccount(info: UserInfo): void {
		this.account = info;
		this.display();
	}
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
