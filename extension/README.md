# Functional extension suite

Black-box tests for the SingleFile extension on Chromium and Firefox. They ask the
extension to do something the way a user would, then check the file it wrote.

```
npm run test-extension                       both browsers, every spec
npm run test-extension-firefox               one browser
node extension/run.mjs --spec=save-page      one spec
node extension/run.mjs --shard=2/3           the second of three groups of specs
node extension/run.mjs --headful             watch it happen
npm run test-release                         the packaged builds, then the format suite
```

`--shard=i/n` splits the specs into `n` groups of similar length and runs group `i`. The
CI workflows of the two extensions start one job per group to shorten the run. The split
uses the durations listed in `SPEC_WEIGHTS` at the top of `run.mjs`: a slow new spec
should be added there. A release is gated on a run without `--shard`.

The extensions under test are the sibling checkouts: `single-file` (MV2, Firefox) and
`single-file-mv3` (MV3, Chromium). Override with `SF_EXTENSION_FIREFOX` and
`SF_EXTENSION_CHROMIUM`. Both must be built (`./build.sh`) before running.

## Trying a change by hand

`node extension/verify.mjs --url=<page>` installs the working tree of the extension, saves the page
and returns the saved file with screenshots of the page and of the saved file. It asserts nothing:
it is the manual check made repeatable, for a page and options chosen on the spot. `--select` saves
a selection, `--action=edit-and-save-page` opens the annotation editor, `--options` sets options
first, `--browser=both` runs the two browsers. The usage is at the top of the script.

## Before a release

`npm run test-release` is the gate. It runs the extension suite against the **packaged**
build and then the format suite, in that order, because the extension suite is what
produces the archives the format suite loads.

`--release` unpacks `singlefile-extension-firefox.zip` and
`singlefile-extension-chromium.zip` into a temp directory and installs that, instead of
the working tree. The two are not the same thing, which is the whole point: the Edge and
Chromium packages are built from patched sources, packaging is where the Woleet key is
injected, and the zip contains only the files `build-extension.sh` lists — a file present
in the checkout but missing from that list works in every test and is absent from the
release. Run `./build-extension.sh` in each repo first.

Every run prints which build it graded, and warns when the package is older than the
sources it was built from. The unpacked copy carries the injected Woleet key; it is
removed when the session closes, and also on exit, interrupt or a broken pipe, so a run
you cut short does not leave a key in `/tmp`. Do not copy that directory anywhere.

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
`save-selected-tabs`, `save-unpinned-tabs`, `save-all-tabs`, the three `save-*-tabs-in-archive`
actions, plus `capture-page`.

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

Since Firefox 156 an extension page is a privileged browsing context, and with
`-remote-allow-system-access` only navigate, reload, close, `getTree` and script
evaluation accept one: `setViewport`, `locateNodes`, `input.performActions` and
`input.setFiles` answer "The command does not support browsing contexts in privileged
scope". The helpers try the real command first and, once a page has been refused, drive it
through its own scripts: a `click()` on the element, an emptied value plus a `change`
event for the permission lists, a `File` built in the page for the import. Chromium, older
Firefox and web pages keep real input, so a spec stays at level 2 in its own eyes; on those
Firefox builds it is level 3 underneath, and `session.mjs` says so.

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

Name the element an assertion is about. `expect/saved-page.mjs` exposes `elementWithId`
for this, because searching a whole saved page for something like `data:image` passes as
soon as *any* image was inlined, including when the element under test was dropped
entirely. Two tests here passed that way before they were tightened.

Remember that SingleFile compresses its output, so attributes are quoted only when they
have to be. A pattern written for quoted values will silently match almost nothing.

**A spec that asks for a save must wait for its file.** The download directory is shared
by every spec in a session, so a save left in flight lands there *after* the next spec has
called `clearDownloads`, and from then on every `waitForDownload` returns the previous
test's file. The lag is silent until some assertion happens to care which page it got —
one dispatch with no `waitForDownload` cost seven failures three specs later, all of them
reported against innocent code.

## Auto-save

Three specs: `autosave` (when a page is saved and how many times, per mode), `autosave-discard`
(the discard mode and the MV3 store of hidden-tab captures, level 3) and `autosave-navigation`
(going back, and which profile a page left for another site is saved with). Their helpers
are in `expect/autosave.mjs`. They grade the number of files per page title, never the
content.

Auto-save is switched on per tab with the external `enableAutoSave` message, on a page that
is not under test, and the page under test is then loaded in that tab: the content script
reads the setting when a page starts loading.

What cost time when these were written, 2026-11-12:

- **A relay left idle for 30 seconds was gone.** Chromium stops an MV3 service worker after
  30 seconds without an extension event or API call, and a pending `fetch` does not count.
  The relay now calls an extension API on every poll. Before that, one long wait in a spec
  made every later dispatch fail with "relay did not answer".
- **A discarded tab is a new tab on Chromium** (157: new tab id, new browsing context). The
  context the spec opened no longer closes it, `closeTab` swallows the error, and the tab is
  reloaded when it becomes active again. Close such a page with `closeTabsShowing`, and
  before the tab in front of it.
- **Reading the store hides the tab in front**, because it opens an extension page. If that
  tab has auto-save in discard mode its capture is stored, rightly. So the store check only
  counts the records of the page under test. Both points together looked exactly like a
  leak in the store and were not one.
- **The specs were checked against older builds**, with `SF_EXTENSION_FIREFOX` and
  `SF_EXTENSION_CHROMIUM` pointing at a `git archive` of the commit before each fix: 8 of
  the first 13 tests fail on Firefox before `25e79e9d`, 5 on Chromium before `c22f59c`, the
  double save on tab close fails at `25e79e9d`, the marker test before `5632d1b2`. The
  Chromium `pagehide` change is NOT discriminated: the build before it also passes.

## Known failures

A test may assert the behaviour SingleFile *should* have and name the defect that stops
it:

```js
await test("a title longer than the limit is truncated to the limit", async () => {
    …
}, { known: "the ellipsis added after truncation is not counted against filenameMaxLength" });
```

Failing then reports `KNOWN` and leaves the run green. Passing is a failure, because a
known failure that starts passing means the defect is fixed and the marker has started
lying about the code. Use this rather than weakening an assertion to match a bug: the
weakened version locks the bug in and nothing tells you when it goes away.

## The other faces

`format/specs/faces.spec.js` is where the archive gets opened as something other than a
page. An SFZ is valid in up to four formats at once, and every other spec in this
repository reaches it through the HTML bootstrap — the one face that cannot tell you the
others are gone. `compression.js` is allowed to drop a face whose payload no wrapper rung
fits, which is correct behaviour: a face is a convenience and the archive is not. The file
still saves, still self-extracts, and simply is not a PNG any more.

So those tests rename the fixture and hand it to the reader that owns the extension:
`zipinfo` and `unzip -t` for the ZIP face, `pdftotext` and `pdfinfo` for the PDF face, a
real `<img>` in all three engines for the PNG face. Renaming to `.zip` is deliberately not
a browser test — a browser hands a `.zip` to the download manager, so there is nothing
rendered to assert.

Two things there are worth knowing. The PNG chunk framing is parsed in
`format/lib/readers.js` rather than delegated, because the archive rides inside a `tEXt`
chunk whose length and CRC are patched after the archive bytes are final: get either wrong
and every viewer still shows the image, since the damage is past the pixel data. And
poppler is optional — those tests skip loudly rather than fail when `pdftotext` is not
installed, which matters because a skipped test in a release gate is not a passing one.

## The fixture pages

`fixtures/pages/simple.html` is a stylesheet, an image and a script — enough for a test
about something else, too easy to grade a save on.

`fixtures/pages/rich.html` is the one to reach for when the subject is fidelity. It
carries an `@import` a level down, a webfont, a shadow root with an adopted stylesheet, a
canvas holding pixels no markup describes, a same-origin frame, a sandboxed `srcdoc` frame
the page cannot reach into, `srcset` and `<picture>`, a background image reached through a
CSS custom property, and a lazy image three thousand pixels below the fold. Each of those
is a thing SingleFile has to do real work to keep.

`fixtures/pages/shadow-selection.html` is the page of the `selection-in-shadow-root` spec: a
component whose shadow root holds the paragraph to select, open by default, closed with
`?mode=closed`, inside the shadow root of another component with `?mode=nested`. The spec
selects with a real mouse drag, because the browsers do not show a script the same thing for
such a selection (Chromium hides it from the classic selection API) and a range written by a
script is handed back as written in both.

`fixtures/pages/bare-text-selection.html` is the page of the `selection-bare-text` spec: text
written directly in `<body>` and in a `<div>`, in no element of its own, around the elements to
select, the way the Lua manual writes the description of its functions (SingleFile#2066). The
ranges are written by a script of the page, which is enough in the light DOM. The spec fails on
the extensions up to 1.39.0, where that text was saved with every selection.

`fixtures/pages/selected-links.html` is the page of the `selected-links` spec: a list where each
link is alone in its item, as on a DokuWiki index (SingleFile#2068). The spec runs "Save selected
links" on four selections and reads the URLs in the page that lists them. It fails on the
extensions up to 1.39.0, where the link a selection started in was missing from the list.

The `failed-save` spec has no page of its own. It saves the selection of `simple.html` with
nothing selected, presses Escape in the selection of an area that SingleFile then opens, and reads
the page of the pending saves. It fails on the extensions up to 1.40.0, where a save that ended
without a file kept its task. A page cannot make the capture throw, so the tests of that case run
only with `SF_FAILED_SAVE_PROBE=1` and builds whose `processPage` throws on a URL holding
`sf-probe-throw`, given with `SF_EXTENSION_FIREFOX` and `SF_EXTENSION_CHROMIUM`.

The sandboxed frame grades the frame-tree protocol rather than the saver. Its origin is
opaque, so `contentDocument` is null and the only source the parent has on its own is the
`srcdoc` attribute, which no script has run against. The frame's inline script rewrites a
marker, so the saved file reads `SANDBOXED_FRAME_RENDERED` when the frame answered for
itself and `SANDBOXED_FRAME_RAW` when the parent fell back to re-parsing srcdoc.

The server also answers two request shapes that save writing a fixture per case:

- `fixtures.titledURL(title)` serves a page whose `<title>` is exactly that string. The
  default filename template is built from the title, so this is how `filename.spec.mjs`
  drives names through the sanitizers.
- `?csp=<policy>` on any fixture URL serves it under that Content-Security-Policy.
