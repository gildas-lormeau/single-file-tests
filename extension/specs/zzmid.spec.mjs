import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";
import { copyFileSync, readFileSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-gildas-Desktop-Dev-project-zip-js/6647e6ad-7f8c-4123-b976-58c106dd5e4a/scratchpad/";
const PAGES = [
	["sprint", "https://sprint.mnogosdelal.ru/"],
	["ionext", "http://localhost:8931/io-next.html"]
];

export const name = "zzmid";
export const level = 2;

export async function run({ session, test }) {
	await session.importSettings({ loadDeferredImagesDispatchScrollEvent: true });
	for (const [label, url] of PAGES) {
		for (const position of ["top", "mid"]) {
			await test(label + " saved from " + position, async () => {
				clearDownloads(session.downloadDir);
				const context = await session.openTab(url);
				await new Promise(resolve => setTimeout(resolve, 7000));
				if (position === "mid") {
					await session.evaluate(context, "scrollTo(0, document.documentElement.scrollHeight * 0.5)");
					await new Promise(resolve => setTimeout(resolve, 2500));
				}
				await session.dispatch("save-page");
				const savedPath = await waitForDownload(session.downloadDir, { timeout: 180000 });
				const target = SCRATCH + "mid-" + label + "-" + position + ".html";
				copyFileSync(savedPath, target);
				const content = readFileSync(target, "utf8");
				console.log("     " + label + " " + position + ": revealed=" + (content.match(/t-animate_started/g) || []).length +
					"/" + (content.match(/t-animate(?![_a-z])/g) || []).length +
					" articleTwo=" + (content.includes("Article Two") ? "YES" : "no") +
					" KB=" + Math.round(content.length / 1024));
				return undefined;
			});
		}
	}
}
