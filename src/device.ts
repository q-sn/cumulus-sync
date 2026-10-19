import { type App, Platform } from "obsidian";

const KEY = "cumulus-device";

export interface RemoteFolder {
	id: string;
	path: string;
}

/** Per-device settings. data.json is shared through pCloud Drive on desktop, these must not be. */
export interface DeviceConfig {
	id: string;
	enabled: boolean;
	folder: RemoteFolder | null;
}

export class Device {
	private config: DeviceConfig;

	constructor(private readonly app: App) {
		const saved = app.loadLocalStorage(KEY) as Partial<DeviceConfig> | null;
		this.config = {
			id: saved?.id ?? crypto.randomUUID(),
			enabled: saved?.enabled ?? false,
			folder: saved?.folder ?? null,
		};
		if (!saved?.id) this.save();
	}

	get id(): string {
		return this.config.id;
	}

	get enabled(): boolean {
		return this.config.enabled;
	}

	get folder(): RemoteFolder | null {
		return this.config.folder;
	}

	update(patch: Partial<Omit<DeviceConfig, "id">>): void {
		this.config = { ...this.config, ...patch };
		this.save();
	}

	private save(): void {
		this.app.saveLocalStorage(KEY, this.config);
	}
}

export function defaultDeviceName(): string {
	if (Platform.isAndroidApp) return "android";
	if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
	if (Platform.isMacOS) return "mac";
	if (Platform.isWin) return "windows";
	return "linux";
}
