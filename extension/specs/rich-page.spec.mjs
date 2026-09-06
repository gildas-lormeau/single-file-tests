// Level 1 spec: one save of a page that is actually hard to save.
//
// simple.html is a stylesheet, an image and a script — almost any implementation would
// get it right, so an assertion made against it grades on a soft page. rich.html carries
// the things that have historically broken: an @import a level down, a webfont, a shadow
// root with an adopted stylesheet, a canvas holding pixels no markup describes, a same
// origin frame, a sandboxed one the page cannot reach into, srcset and <picture>, a
// background image reached through a CSS custom property, and an image far below the fold
// that is not loaded when the save starts.
//
// One save, many assertions: each capture is a real one and re-saving per assertion
// would only re-measure the same artifact.

import {
	waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration, elementWithId
} from "../expect/saved-page.mjs";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const FRAME_MARKER = "IFRAME_CONTENT_MARKER";
const SANDBOXED_FRAME_RAW = "SANDBOXED_FRAME_RAW";
const SANDBOXED_FRAME_RENDERED = "SANDBOXED_FRAME_RENDERED";
const SHADOW_MARKER = "SHADOW_DOM_MARKER";
const DATA_IMAGE = /data:image\/(png|svg\+xml);base64,/;
const DATA_FONT = /url\(["']?data:(font|application)\/[^;]+;base64,/;

export const name = "rich-page";
export const level = 1;

export async function run({ session, fixtures, test }) {
	let content;

	await test("a page with frames, shadow DOM and a canvas saves at all", async () => {
		clearDownloads(session.downloadDir);
		await session.openTab(fixtures.url("rich.html"));
		await session.dispatch("save-page");
		content = readSavedPage(await waitForDownload(session.downloadDir));
		const problems = expectSelfContained(content, { markerText: MARKER_TEXT });
		return problems.length ? problems.join("; ") : undefined;
	});

	await test("stylesheets are inlined through the @import", async () => {
		const problems = [];
		if (!includesDeclaration(content, "color: rgb(17, 85, 204)")) {
			problems.push("the directly linked stylesheet is missing");
		}
		if (!includesDeclaration(content, "color: rgb(200, 30, 90)")) {
			problems.push("the @import-ed stylesheet was not followed");
		}
		if (!includesDeclaration(content, "outline: 2px solid rgb(9, 121, 105)")) {
			problems.push("the inline <style> rule is missing");
		}
		return problems.join("; ") || undefined;
	});

	await test("rules that match nothing are dropped", async () => {
		// removeUnusedStyles is on by default, and both of these select elements the page
		// does not contain
		const problems = [];
		if (content.includes("never-matched-external")) {
			problems.push("an unused rule from the external stylesheet was kept");
		}
		if (content.includes("never-matched-inline")) {
			problems.push("an unused rule from the inline stylesheet was kept");
		}
		return problems.join("; ") || undefined;
	});

	await test("the webfont is embedded rather than left as a URL", () => {
		if (!content.includes("FixtureFont")) {
			return "the @font-face rule was dropped even though the page uses it";
		}
		return DATA_FONT.test(content) ? undefined : "the font file was not embedded as a data URI";
	});

	await test("the background image behind a custom property is inlined", () => {
		// the URL only ever appears as var(--backdrop), so resolving it means the saver
		// followed the custom property rather than scanning for literal url() tokens
		if (content.includes("backdrop.png")) {
			return "backdrop.png was left as an external reference";
		}
		if (!elementWithId(content, "backdrop")) {
			return "the element using the custom property is gone, so nothing was proved";
		}
		return /--backdrop:\s*url\(data:image\/png;base64,/.test(content)
			? undefined
			: "the custom property no longer holds an embedded image";
	});

	await test("frame content is kept with the page", () => {
		const problems = [];
		if (!content.includes(FRAME_MARKER)) {
			problems.push("the frame's text is missing");
		}
		if (!includesDeclaration(content, "color: rgb(70, 30, 160)")) {
			problems.push("the frame's own stylesheet is missing");
		}
		return problems.join("; ") || undefined;
	});

	await test("a sandboxed frame is saved as it renders, not as its srcdoc reads", () => {
		// the frame is an opaque origin, so contentDocument is null and the parent's only
		// local source is the srcdoc attribute, which no script has touched. The extension
		// injects into about:srcdoc as well, so the frame can answer for itself, and its
		// answer is the only one carrying the text the frame actually displays
		const problems = [];
		if (!content.includes(SANDBOXED_FRAME_RENDERED)) {
			problems.push("the sandboxed frame's rendered text is missing");
		}
		if (content.includes(SANDBOXED_FRAME_RAW)) {
			problems.push("the saved copy holds the raw srcdoc, so the frame's own answer was not used");
		}
		return problems.join("; ") || undefined;
	});

	await test("shadow DOM content and its adopted stylesheet are kept", () => {
		// a shadow root has no serialization of its own, so it comes back as a declarative
		// one; the adopted stylesheet has to be written out as a real <style> with it
		const problems = [];
		if (!content.includes(SHADOW_MARKER)) {
			problems.push("the shadow root's text is missing");
		}
		if (!/<template\s+shadowrootmode=["']?open/.test(content)) {
			problems.push("no declarative shadow root in the saved page");
		}
		if (!includesDeclaration(content, "color: rgb(120, 20, 20)")) {
			problems.push("the adopted stylesheet is missing");
		}
		return problems.join("; ") || undefined;
	});

	await test("the canvas keeps the pixels that were drawn into it", () => {
		// nothing in the markup describes the drawing, so the only way it survives is if
		// the saver read the bitmap back out. It comes back as a background image on the
		// canvas element itself, which is why this looks at that element and not the page.
		const canvas = elementWithId(content, "canvas");
		if (!canvas) {
			return "the canvas element is gone from the saved page";
		}
		return DATA_IMAGE.test(canvas) ? undefined : "the canvas carries no embedded bitmap";
	});

	await test("srcset is resolved to a single embedded image", () => {
		const problems = [];
		["responsive", "picture-image"].forEach(id => {
			const image = elementWithId(content, id);
			if (!image) {
				problems.push(id + " is gone from the saved page");
			} else if (!DATA_IMAGE.test(image)) {
				problems.push(id + " was not embedded");
			} else if (/srcset=["']?\w/.test(image)) {
				problems.push(id + " still carries an unresolved srcset");
			}
		});
		return problems.join("; ") || undefined;
	});

	await test("an image below the fold is loaded before the save", () => {
		// loading="lazy" three thousand pixels down: it has not been fetched when the save
		// starts, so this only passes if loadDeferredImages did its work
		if (content.includes("lazy.png")) {
			return "lazy.png was left as an external reference";
		}
		const lazy = elementWithId(content, "lazy");
		if (!lazy) {
			return "the lazy image is gone from the saved page, so nothing was proved";
		}
		return DATA_IMAGE.test(lazy) ? undefined : "the lazy image was never loaded, so it saved empty";
	});
}
