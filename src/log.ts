import { redact } from "./pcloud/types";

export interface LogEntry {
	time: number;
	level: "info" | "warn" | "error";
	message: string;
}

const MAX = 500;

export class Log {
	private entries: LogEntry[] = [];

	info(message: string): void {
		this.push("info", message);
	}

	warn(message: string): void {
		this.push("warn", message);
	}

	error(message: string): void {
		this.push("error", message);
	}

	all(): readonly LogEntry[] {
		return this.entries;
	}

	private push(level: LogEntry["level"], message: string): void {
		message = redact(message);
		this.entries.push({ time: Date.now(), level, message });
		if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
		if (level === "error") console.error(`[cumulus] ${message}`);
	}
}
