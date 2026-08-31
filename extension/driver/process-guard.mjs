// A last-resort net for things that must not outlive the run: the browsers and drivers
// the harness spawned, and the directories it unpacked.
//
// Ordinary teardown is close()'s job and this does not replace it. This is for the ways a
// run ends without reaching close(): an interrupt, a spec throwing past the teardown, or
// stdout closing early — piping the runner through head(1) is enough, and that is how the
// stray chromedrivers and unpacked release directories this exists to prevent were made.
//
// Only processes this harness started are ever signalled, by pid. Nothing here searches
// for browsers by name: the machine running the suite is also somebody's desktop, and
// their own Firefox is not ours to kill.

import { rmSync } from "node:fs";

export { guardProcess, releaseProcess, guardDirectory, releaseDirectory };

const processes = new Set();
const directories = new Set();
let registered = false;

function guardProcess(child) {
	register();
	processes.add(child);
	// a process that ends on its own is no longer ours to worry about
	child.once("exit", () => processes.delete(child));
}

function releaseProcess(child) {
	processes.delete(child);
}

function guardDirectory(path) {
	register();
	directories.add(path);
}

function releaseDirectory(path) {
	rmSync(path, { recursive: true, force: true });
	directories.delete(path);
}

function register() {
	if (registered) {
		return;
	}
	registered = true;
	// exit handlers have to be synchronous, so this is kill and unlink, no waiting
	process.on("exit", cleanUp);
	["SIGINT", "SIGTERM", "SIGHUP"].forEach(signal => process.on(signal, () => {
		cleanUp();
		process.exit(1);
	}));
}

function cleanUp() {
	processes.forEach(child => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	});
	processes.clear();
	directories.forEach(path => rmSync(path, { recursive: true, force: true }));
	directories.clear();
}
