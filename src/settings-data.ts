import { Platform } from "obsidian";

export interface CumulusSettings {
	autoSync: boolean;
	intervalMinutes: number;
	exclude: string[];
	/** null: 25 MB on mobile, 200 MB on desktop */
	maxFileSizeMb: number | null;
	deviceName: string;
}

export const DEFAULT_SETTINGS: CumulusSettings = {
	autoSync: true,
	intervalMinutes: 5,
	exclude: [],
	maxFileSizeMb: null,
	deviceName: "",
};

export function maxFileSizeBytes(s: CumulusSettings): number {
	const mb = s.maxFileSizeMb ?? (Platform.isMobileApp ? 25 : 200);
	return Math.round(mb * 1024 * 1024);
}
