import { test, expect } from "@playwright/test";
import { fixtureURL } from "../lib/fixtures-def.js";

// A corrupted archive must fail loudly: visible error message, no marker,
// no infinite "Please wait...".

test("corrupted archive shows the error message", async ({ page }) => {
	await page.goto(fixtureURL("archive-corrupted.html"));
	await expect(page.locator("#sfz-error-message")).toBeVisible();
	await expect(page.locator("#marker")).toHaveCount(0);
	await expect(page.locator("#sfz-wait-message")).toHaveCount(0);
});
