// The relay needs a different manifest per browser (MV3 service worker on Chromium,
// MV2 background page on Firefox) but the same relay.js, so stage it at run time
// rather than keeping two near-identical copies in the repo.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const RELAY_SOURCE = fileURLToPath(new URL("./relay.js", import.meta.url));
const RELAY_ID = "{2f0b6a54-9c3d-4e78-a1b2-7d5e3c9f4a60}";

export { buildRelay };

function buildRelay(browserName, bridgeURL) {
	const stagingDir = mkdtempSync(join(tmpdir(), "sf-fn-relay-"));
	const source = readFileSync(RELAY_SOURCE, "utf8").replace("__BRIDGE_URL__", bridgeURL);
	writeFileSync(join(stagingDir, "relay.js"), source);
	writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest(browserName), null, "\t"));
	return stagingDir;
}

function manifest(browserName) {
	const common = {
		name: "SingleFile functional test relay",
		version: "1.0",
		description: "Relays harness commands to SingleFile's external messaging API"
	};
	if (browserName == "firefox") {
		return {
			...common,
			manifest_version: 2,
			// a fixed id keeps the relay recognisable in logs across runs
			browser_specific_settings: { gecko: { id: RELAY_ID } },
			background: { scripts: ["relay.js"], persistent: true },
			permissions: ["<all_urls>"]
		};
	}
	return {
		...common,
		manifest_version: 3,
		background: { service_worker: "relay.js" },
		host_permissions: ["<all_urls>"]
	};
}
