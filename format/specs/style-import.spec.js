import { test, expect } from "@playwright/test";
import { fixtureURL, MARKER_TEXT, IMPORT_FIXTURES, IMPORTED_COLOR } from "../lib/fixtures-def.js";

// A stylesheet imported by a <style> element of the archived page must be applied once the
// archive has self-extracted. Firefox lost it, and with it the web fonts of pages loading Google
// Fonts that way, while Chromium and WebKit applied it.

for (const { name } of IMPORT_FIXTURES) {
	test(`${name} applies the stylesheet its style element imports`, async ({ page }) => {
		await page.goto(fixtureURL(name));
		await expect(page.locator("#marker")).toHaveText(MARKER_TEXT);
		await expect(page.locator("#marker")).toHaveCSS("color", IMPORTED_COLOR);
	});
}
