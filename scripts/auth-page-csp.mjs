// updates the script hash in auth-page CSP
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../auth-page/index.html", import.meta.url);
const html = readFileSync(file, "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (script === undefined) throw new Error("inline script not found");
const hash = createHash("sha256").update(script, "utf8").digest("base64");
writeFileSync(file, html.replace(/script-src 'sha256-[^']*'/, `script-src 'sha256-${hash}'`));
console.log(`script-src 'sha256-${hash}'`);
