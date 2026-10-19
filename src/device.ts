import { type App, FileSystemAdapter, Platform } from "obsidian";

const KEY = "cumulus-device";

export interface RemoteFolder {
	id: string;
	path: string;
}

/** Per-device settings. data.json is shared through pCloud Drive on desktop, these must not be. */
export interface DeviceConfig {
	id: string;
	folder: RemoteFolder | null;
	/** Shown in settings right away, before pCloud answers. */
	email: string | null;
}

export class Device {
	private config: DeviceConfig;

	constructor(private readonly app: App) {
		const saved = app.loadLocalStorage(KEY) as Partial<DeviceConfig> | null;
		this.config = {
			id: saved?.id ?? crypto.randomUUID(),
			email: saved?.email ?? null,
			folder: saved?.folder ?? null,
		};
		if (!saved?.id) this.save();
	}

	get id(): string {
		return this.config.id;
	}

	get email(): string | null {
		return this.config.email;
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

/** Syncing a vault that pCloud Drive already syncs would sync the folder with itself. */
export function vaultInsidePCloudDrive(app: App): boolean {
	const adapter = app.vault.adapter;
	if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return false;
	const base = adapter.getBasePath();
	return /pcloud ?drive/i.test(base) || /^p:[\\/]/i.test(base);
}
