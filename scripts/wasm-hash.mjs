// Fingerprint of the Rust sources the committed wasm package was built from.
// `node scripts/wasm-hash.mjs write` after building, `check` in CI.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STAMP = "crates/wasm/pkg/source-hash.txt";
const roots = ["Cargo.toml", "Cargo.lock", "crates/core", "crates/wasm/Cargo.toml", "crates/wasm/src"];

function files(path) {
	if (statSync(path).isFile()) return [path];
	return readdirSync(path)
		.flatMap((name) => files(join(path, name)))
		.filter((f) => /\.(rs|toml|lock)$/.test(f));
}

const hash = createHash("sha256");
for (const f of roots.flatMap(files).map((f) => f.replace(/\\/g, "/")).sort()) {
	hash.update(f).update("\0").update(readFileSync(f, "utf8").replace(/\r\n/g, "\n")).update("\0");
}
const digest = hash.digest("hex");

if (process.argv[2] === "write") {
	// wasm-pack drops a .gitignore with "*" into the package; the package is committed on purpose
	rmSync("crates/wasm/pkg/.gitignore", { force: true });
	// generated typings open with blanket lint switches, which Obsidian's review rejects
	for (const f of readdirSync("crates/wasm/pkg").filter((n) => n.endsWith(".d.ts"))) {
		const path = `crates/wasm/pkg/${f}`;
		const text = readFileSync(path, "utf8");
		writeFileSync(path, text.replace(/^\/\* (tslint:disable|eslint-disable) \*\/\r?\n/gm, ""));
	}
	writeFileSync(STAMP, `${digest}\n`);
} else {
	const stamped = readFileSync(STAMP, "utf8").trim();
	if (stamped !== digest) {
		console.error("crates/wasm/pkg is out of date with the Rust sources: run `npm run build:wasm` and commit it");
		process.exit(1);
	}
	console.log("wasm package matches the Rust sources");
}
