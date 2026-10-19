import { Notice, Platform, Plugin } from "obsidian";
import { AuthManager } from "./auth";
import { PROTOCOL_ACTION } from "./config";
import { coreVersion, loadCore } from "./core";
import { obsidianTransport } from "./pcloud/obsidian-transport";
import { CumulusSettingTab } from "./settings";

export default class CumulusPlugin extends Plugin {
	private auth!: AuthManager;

	async onload(): Promise<void> {
		await loadCore();
		this.auth = new AuthManager(this.app, obsidianTransport);
		const settings = new CumulusSettingTab(this.app, this, this.auth);
		this.addSettingTab(settings);

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, async (params) => {
			try {
				const info = await this.auth.completeOAuth(params);
				new Notice(`Cumulus: connected as ${info.email}`);
				settings.setAccount(info);
			} catch (e) {
				new Notice(`Cumulus: ${e instanceof Error ? e.message : String(e)}`);
			}
		});

		this.addCommand({
			id: "self-test",
			name: "Run self-test",
			callback: () => void this.selfTest(),
		});
	}

	private async selfTest(): Promise<void> {
		const sample = new TextEncoder().encode("cumulus");
		const digest = await crypto.subtle.digest("SHA-1", sample);
		const sha1 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
		const platform = Platform.isMobileApp ? "mobile" : "desktop";
		let account = "pCloud: not connected";
		const client = this.auth.client();
		if (client) {
			try {
				const root = await client.listFolder("0");
				account = `pCloud: ${(await client.userInfo()).email}, ${root.contents?.length ?? 0} items in root`;
			} catch (e) {
				account = `pCloud: ${e instanceof Error ? e.message : String(e)}`;
			}
		}
		new Notice(`Cumulus core ${coreVersion()} on ${platform}\nsha1 ok: ${sha1.slice(0, 8)}\n${account}`, 10000);
	}
}
