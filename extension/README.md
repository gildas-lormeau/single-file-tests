# Functional extension suite

Black-box tests for the SingleFile extension on Chromium and Firefox. They ask the
extension to do something the way a user would, then check the file it wrote.

```
npm run test-extension                       both browsers, every spec
npm run test-extension-firefox               one browser
node extension/run.mjs --spec=save-page      one spec
node extension/run.mjs --headful             watch it happen
```

The extensions under test are the sibling checkouts: `single-file` (MV2, Firefox) and
`single-file-mv3` (MV3, Chromium). Override with `SF_EXTENSION_FIREFOX` and
`SF_EXTENSION_CHROMIUM`. Both must be built (`./build.sh`) before running.

Chromium needs a `chromedriver` matching the installed Chrome. The runner looks in the
Selenium and Puppeteer caches and picks the closest major; `SF_CHROMEDRIVER_PATH` and
`SF_CHROME_PATH` override. Firefox is found in the usual locations, or `SF_FIREFOX_PATH`.

## How it drives the extension

One WebDriver BiDi client covers both browsers. Only the launch differs: Firefox speaks
BiDi natively, Chromium gets its BiDi socket from chromedriver. Two flags are load-bearing
and easy to lose:

- Firefox needs `-remote-allow-system-access` (single dash), without which navigating to
  or evaluating in an extension page is refused outright.
- Chromium needs `--enable-unsafe-extension-debugging` and `--remote-debugging-pipe`, or
  `webExtension.install` is rejected.

Firefox's `moz-extension:` UUID is random per profile, so the launcher pins it in the
profile before first start. That is what makes extension URLs predictable.

## The three levels

Every spec declares the `level` it needs. Lower is better, and a spec should not reach for
a higher level than its subject requires.

**Level 1 — the public external API.** A small relay extension is installed next to
SingleFile and calls `runtime.sendMessage(singlefileId, …)`, which SingleFile already
handles in `src/core/bg/external-messages.js`. Nothing is injected into SingleFile, and
the harness exercises the same action strings the menu items use: `save-page`,
`edit-and-save-page`, `save-selected-links`, `save-selected-content`,
`save-selected-tabs`, `save-unpinned-tabs`, `save-all-tabs`, plus `capture-page`.

`capture-page` is the only one that returns a value, so it is the only caller that needs
`dispatch(message, { expectResponse: true })`. It is also gated by a permission prompt:
SingleFile opens its options page with an `externalCaptureRequestId` in the query string
and waits for a real click on Approve. Note the prompt tab stays open after approval and
becomes the active tab, and `capture-page` targets whichever tab is active — so re-open
the page you meant to capture before asking again.

The relay long-polls the harness over loopback HTTP rather than holding a WebSocket,
because an MV3 service worker can be terminated between commands.

**Level 2 — real input into SingleFile's own pages.** `input.performActions` clicks and
types into the options page or the panel for real. Use this for anything the external API
does not expose. It is still black box: it drives the UI, it does not reach inside it.

Two things make this work, and both are easy to lose. Give the options page a tall
viewport (`session.setViewport`), because a pointer aimed at a control below the fold
errors on Firefox and *silently hits the wrong element* on Chromium. And click
`#expandAllButton` first, since the controls sit in collapsed `<details>` whose summaries
otherwise sit on top of them.

`session.importSettings(profile)` sets any option without touching its widget, through the
options page's own Import button and a real file handed to its `<input type="file">`. Keys
left out are filled from `DEFAULT_CONFIG`, so a partial profile is enough. This exists
because a `<select>` cannot be driven by synthetic input on macOS — clicking it opens a
native menu that swallows the keys, and `<option>` elements are rejected as pointer
origins. Import sidesteps the widget instead of faking a gesture, and needs no test-only
code in the extension.

**Level 3 — evaluating in an extension page.** Last resort. Mark the spec, because at that
point the test knows about the implementation.

## What this suite cannot do

The toolbar button, the native page context menu, and the OS-level keyboard shortcut are
browser chrome. Neither BiDi nor CDP reaches them, and Firefox's privileged chrome context
does not help because a headless browser never builds the extension's widgets. Level 1
covers the same handlers, since the menu items and the external API both funnel into
`business.saveTabs(...)`.

One known gap: the `save-selected-tabs` *command* passes `{ optionallySelected: true }`
while the external action of the same name does not, so that pair is near-equivalent
rather than identical.

## The hand-off to the format suite

`specs/archive.spec.mjs` switches the save format to a self-extracting archive, checks the
extension really produced one, and copies it to `fixtures/extension-saved-<browser>.html`.
`tests/extension-artifacts.spec.js` then loads those archives in chromium, firefox and
webkit and asserts they self-extract.

That is the only place a page the *extension* saved is checked for self-extraction in a
real engine; everything else in `tests/` checks archives built by `compression.js` in
Node. The artifacts are gitignored and absent until the extension suite has run, so those
specs skip rather than fail.

Use the **universal** variant (`extractDataFromPage: true`) for anything loaded from
`file://`. The plain self-extracting archive fetches its own URL, which `file://` blocks,
so it never extracts there.

## Assertions

They run in Node against the file on disk, never inside the browser. That is the line that
keeps this suite functional rather than a second implementation of the editor. Helpers
live in `expect/`.
