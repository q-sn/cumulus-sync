import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "crates/**", "node_modules/**", "scripts/.out/**", "tests/.out/**", "auth-page/**", "docs/**"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "scripts/*.mjs", "scripts/*.ts", "tests/*.ts"],
				},
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["pCloud", "pCloud Drive", "Cumulus"], ignoreRegex: ["^cumulus1:"] }],
		},
	},
]);
