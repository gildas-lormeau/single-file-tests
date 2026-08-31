import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// build-fixtures.js imports single-file-core (ESM); run it in a subprocess
// because Playwright loads globalSetup with require(), which cannot
// require() that ES module graph
export default function globalSetup() {
	execFileSync(process.execPath, [fileURLToPath(new URL("./build-fixtures-run.js", import.meta.url))], { stdio: "inherit" });
}
