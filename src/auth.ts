import type { App } from "obsidian";
import { AUTH_REDIRECT_URI, PASTE_CODE_PREFIX, PCLOUD_CLIENT_ID } from "./config";
import { PCloudClient } from "./pcloud/client";
import type { Transport } from "./pcloud/transport";
import { PCLOUD_HOSTS, PCloudError, type Session, type UserInfo } from "./pcloud/types";

const TOKEN_SECRET_ID = "cumulus-pcloud-token";
const HOST_KEY = "cumulus-pcloud-host";
const STATE_KEY = "cumulus-oauth-state";
const STATE_TTL_MS = 15 * 60 * 1000;

const VALID_HOSTS: readonly string[] = Object.values(PCLOUD_HOSTS);

// not in data.json: it can get synced along with .obsidian
export class AuthManager {
	constructor(
		private readonly app: App,
		private readonly transport: Transport,
	) {}

	get session(): Session | null {
		const token = this.app.secretStorage.getSecret(TOKEN_SECRET_ID);
		const host = this.app.loadLocalStorage(HOST_KEY) as string | null;
		return token && host && VALID_HOSTS.includes(host) ? { token, host } : null;
	}

	client(): PCloudClient | null {
		const session = this.session;
		return session ? new PCloudClient(this.transport, session) : null;
	}

	get canUseOAuth(): boolean {
		return PCLOUD_CLIENT_ID !== "";
	}

	startOAuth(): void {
		const state = randomState();
		this.app.saveLocalStorage(STATE_KEY, { state, at: Date.now() });
		const url = new URL("https://my.pcloud.com/oauth2/authorize");
		url.search = new URLSearchParams({
			client_id: PCLOUD_CLIENT_ID,
			response_type: "token",
			redirect_uri: AUTH_REDIRECT_URI,
			state,
		}).toString();
		window.open(url.toString());
	}

	async completeOAuth(params: Record<string, string>): Promise<UserInfo> {
		const saved = this.app.loadLocalStorage(STATE_KEY) as { state: string; at: number } | null;
		this.app.saveLocalStorage(STATE_KEY, null);
		if (!saved || saved.state !== params.state || Date.now() - saved.at > STATE_TTL_MS) {
			throw new Error("Sign-in link is stale or was not started from this device. Try connecting again.");
		}
		const token = params.access_token;
		const host = params.hostname;
		if (!token || !host || !VALID_HOSTS.includes(host)) throw new Error("Sign-in response is incomplete.");
		return this.connect({ token, host });
	}

	// "cumulus1:<host>:<token>" from the auth page, or a bare token (region unknown, try both)
	async connectWithCode(input: string): Promise<UserInfo> {
		const code = input.trim();
		const parts = code.split(":");
		if (parts[0] === PASTE_CODE_PREFIX && parts.length === 3) {
			const [, host = "", token = ""] = parts;
			if (!VALID_HOSTS.includes(host) || !token) throw new Error("This sign-in code is not valid.");
			return this.connect({ host, token });
		}
		if (!/^[A-Za-z0-9_-]{16,}$/.test(code)) throw new Error("This sign-in code is not valid.");
		let lastError: unknown = null;
		for (const host of VALID_HOSTS) {
			try {
				return await this.connect({ host, token: code });
			} catch (e) {
				lastError = e;
				if (!(e instanceof PCloudError && e.errorClass === "auth")) throw e;
			}
		}
		throw lastError;
	}

	async disconnect(): Promise<void> {
		const client = this.client();
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, "");
		this.app.saveLocalStorage(HOST_KEY, null);
		await client?.logout().catch(() => undefined);
	}

	private async connect(session: Session): Promise<UserInfo> {
		const info = await new PCloudClient(this.transport, session, { maxAttempts: 2 }).userInfo();
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, session.token);
		this.app.saveLocalStorage(HOST_KEY, session.host);
		return info;
	}
}

function randomState(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
