import esbuild from "esbuild";
import { builtinModules } from "node:module";

const mode = process.argv[2];
const prod = mode === "production";

// plugins ship as a single main.js, so wasm gets inlined
const wasmBinary = {
	name: "wasm-binary",
	setup(build) {
		build.onLoad({ filter: /\.wasm$/ }, async (args) => ({
			contents: await import("node:fs/promises").then((fs) => fs.readFile(args.path)),
			loader: "binary",
		}));
	},
};

if (mode === "spike") {
	await esbuild.build({
		entryPoints: ["scripts/spike.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		outfile: "scripts/.out/spike.mjs",
		plugins: [wasmBinary],
		define: { "import.meta.url": "\"\"" },
		logLevel: "warning",
	});
	process.exit(0);
}

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	plugins: [wasmBinary],
	// init() always gets bytes, import.meta.url is never used
	define: { "import.meta.url": "\"\"" },
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
