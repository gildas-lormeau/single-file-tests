// Level 3 spec: the queue of the pending saves can be paused and resumed, and a paused queue
// survives the stop of the MV3 service worker.
//
// A batch of URLs is a queue of tasks in the background script. The saves already running when
// the queue is paused go to their end, the others wait for the resume. The page of the pending
// saves shows how many saves ended out of the total.
//
// In Chromium the queue lives in the memory of a service worker that the browser stops after 30
// seconds without an event. The page of the pending saves asks for the list every second, which
// keeps the worker alive, so the loss only shows once that page is closed. The paused tasks made
// of a URL are kept in `storage.session` and put back in the queue when the worker starts again.
//
// Level 3 because the batch is started and the queue is read through the messages SingleFile's own
// pages send. The click on the pause button and the counter are read in the real page.

import { clearDownloads, listDownloads } from "../expect/saved-page.mjs";
import { autoSaveHelpers, sleep } from "../expect/autosave.mjs";

// a page of SingleFile that sends no message on its own: the page of the pending saves polls the
// background script, which would keep the service worker alive
const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const PENDINGS_PAGE = "src/ui/pages/pendings.html";
const HELD_URL_COUNT = 2;
const HELD_ARCHIVE_URL_COUNT = 2;
const HELD_COUNT = HELD_URL_COUNT + HELD_ARCHIVE_URL_COUNT;
const POLL_DELAY = 250;
const SETTLE_TIMEOUT = 60000;
const HOLD_DELAY = 3000;
// Chromium stops an idle service worker after 30 seconds
const WORKER_STOP_DELAY = 40000;

export const name = "pending-pause";
export const level = 3;

export async function run({ session, fixtures, test }) {
	const { savedFiles } = autoSaveHelpers({ session, fixtures });
	const run = Date.now();
	let workerCount, runningTitles, heldTitles, archiveUrls, paused;

	// the defaults, whatever the spec before left behind
	await session.closeTab(await session.importSettings({}));

	await test("a pause holds the saves that are not started", async () => {
		clearDownloads(session.downloadDir);
		const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
		await send(control, { method: "archive.clear" });
		// one save per parallel worker starts at once, the pause can only hold what comes after
		workerCount = Number(await session.evaluate(control, "navigator.hardwareConcurrency || 4"));
		runningTitles = titles("running", workerCount);
		heldTitles = titles("held", HELD_URL_COUNT);
		archiveUrls = titles("archived", HELD_ARCHIVE_URL_COUNT).map(fixtures.titledURL);
		// the three messages leave from one script, so that no save has the time to end and to
		// start the next one before the pause
		await session.evaluate(control, "(async () => { " +
			"await browser.runtime.sendMessage(" + JSON.stringify({ method: "downloads.saveUrls", urls: [...runningTitles, ...heldTitles].map(fixtures.titledURL) }) + "); " +
			"await browser.runtime.sendMessage(" + JSON.stringify({ method: "archive.addUrls", urls: archiveUrls }) + "); " +
			"await browser.runtime.sendMessage({ method: \"downloads.pause\" }); })()");
		const { problem } = await savedFiles(Object.fromEntries(runningTitles.map(title => [title, 1])));
		if (problem) {
			await session.closeTab(control);
			return "the saves started before the pause did not all end: " + problem;
		}
		const settled = await waitForTasks(control, info => !info.tasks.some(task => task.status != "pending"));
		await sleep(HOLD_DELAY);
		const info = await tasksInfo(control);
		const saved = listDownloads(session.downloadDir).length;
		await session.closeTab(control);
		paused = !queueProblem(info);
		return (settled ? undefined : "some saves were still processing after " + SETTLE_TIMEOUT + " ms")
			|| queueProblem(info)
			|| (saved == workerCount ? undefined : saved + " file(s) saved during the pause, expected " + workerCount);
	});

	await test("the page of the pending saves shows the saves ended out of the total", async () => {
		if (!paused) {
			return "the queue was not paused by the first test";
		}
		const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
		await sleep(1500);
		const progress = await session.evaluate(context, "document.getElementById(\"progressLabel\").textContent");
		const disabled = await session.evaluate(context, "document.getElementById(\"pauseButton\").disabled");
		await session.closeTab(context);
		const expected = workerCount + " / " + (workerCount + HELD_COUNT);
		return (progress == expected ? undefined : "the counter says " + JSON.stringify(progress) + ", expected " + JSON.stringify(expected))
			|| (disabled ? "the pause button is disabled with saves in the queue" : undefined);
	});

	if (session.browserName != "firefox") {
		await test("a paused queue survives the stop of the service worker", async () => {
			if (!paused) {
				return "the queue was not paused by the first test";
			}
			// no page of SingleFile is open and nothing is asked of it, the worker goes idle
			await sleep(WORKER_STOP_DELAY);
			const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
			const info = await tasksInfo(control);
			await session.closeTab(control);
			// the ids start again at 1 in a new worker: without that, the worker was never
			// stopped and the queue seen here proves nothing
			const restarted = info.tasks.length && Math.min(...info.tasks.map(task => task.id)) == 1;
			return queueProblem(info)
				|| (restarted ? undefined : "the service worker was not stopped during the wait, the test proved nothing");
		});
	}

	await test("the resume button saves the pages that were held", async () => {
		if (!paused) {
			return "the queue was not paused by the first test";
		}
		clearDownloads(session.downloadDir);
		const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
		await sleep(1500);
		await session.click(context, "#pauseButton");
		const { problem } = await savedFiles(Object.fromEntries(heldTitles.map(title => [title, 1])));
		const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
		const ended = await waitForTasks(control, info => !info.tasks.length);
		const info = await tasksInfo(control);
		const pages = await send(control, { method: "archive.getPages" });
		await send(control, { method: "archive.clear" });
		await session.closeTab(control);
		await session.closeTab(context);
		const archived = archiveUrls.filter(url => pages.some(page => page.url == url && !page.failed)).length;
		return problem
			|| (ended ? undefined : info.tasks.length + " save(s) still in the queue after the resume")
			|| (info.paused ? "the queue is still paused once it is empty" : undefined)
			|| (archived == archiveUrls.length ? undefined : archived + " page(s) of " + archiveUrls.length + " reached the archive in progress: " + JSON.stringify(pages).slice(0, 600));
	});

	function titles(label, count) {
		return Array.from({ length: count }, (_, index) => "pause-" + label + "-" + run + "-" + (index + 1));
	}

	// what the queue must hold while it is paused: the held pages, all pending, none started
	function queueProblem(info) {
		const pending = info.tasks.filter(task => task.status == "pending").length;
		return (info.paused ? undefined : "the queue is not paused")
			|| (info.tasks.length == HELD_COUNT && pending == HELD_COUNT ? undefined
				: info.tasks.length + " save(s) in the queue with " + pending + " pending, expected " + HELD_COUNT + " pending")
			|| (info.endedTasksCount == workerCount ? undefined : info.endedTasksCount + " save(s) counted as ended, expected " + workerCount);
	}

	async function waitForTasks(context, isReached) {
		const deadline = Date.now() + SETTLE_TIMEOUT;
		while (Date.now() < deadline) {
			if (isReached(await tasksInfo(context))) {
				return true;
			}
			await sleep(POLL_DELAY);
		}
		return false;
	}

	function tasksInfo(context) {
		return send(context, { method: "downloads.getInfo" });
	}

	async function send(context, message) {
		return JSON.parse(await session.evaluate(context,
			"browser.runtime.sendMessage(" + JSON.stringify(message) + ").then(response => JSON.stringify(response === undefined ? null : response))"));
	}
}
