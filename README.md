# a11y-core-playwright

A Playwright binding for [`a11y-core`](../a11y-core) — scans a real, already-rendered page for accessibility issues using a11y-core's DOM-rules engine.

This is a **separate project/package** from `a11y-core` itself, kept as a sibling directory (`../a11y-core`) rather than a monorepo subfolder — see `ROADMAP.md` for the reasoning behind that split and everything else about this project's status.

## Install (local development)

`a11y-core` isn't published to npm yet, so this package depends on it via a relative `file:` path (see `package.json`):

```json
"dependencies": { "a11y-core": "file:../a11y-core" }
```

That means this project must stay a sibling of `a11y-core` (or you update the path) for `npm install` to resolve it.

```bash
npm install
npm test
```

## Usage

```js
const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('a11y-core-playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com/');

const results = await new A11yCoreBuilder({ page })
  .include('#main')            // optional -- call multiple times for multi-region scans
  .exclude('.cookie-banner')    // optional
  .withTags(['wcag2a', 'wcag2aa'])
  .disableRules(['a11ycore-meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
await browser.close();
```

`results` is a11y-core's own native result shape — see [`../a11y-core/docs/OUTPUT_SCHEMA.md`](../a11y-core/docs/OUTPUT_SCHEMA.md) — not axe-core's `violations`/`passes`/`incomplete`/`inapplicable` shape. The builder's *method names* are modeled on axe-core's `AxeBuilder` for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

### Scanning every frame, including cross-origin iframes

```js
const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

Unlike axe-core (which needs a `postMessage`-based protocol to reach cross-origin iframes, since it's injected as a plain `<script>` fully subject to the browser's same-origin policy), this needs no `a11y-core` engine support at all — Playwright drives every frame via CDP at the automation-process level, so cross-origin `frame.evaluate()` already just works. Verified against a real cross-origin page (`example.org` embedded in an unrelated origin) — see `ROADMAP.md` gap #1 and `tests/builder.test.js`. Default off, so plain `.analyze()` is unaffected unless you opt in.

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — a11y-core's own deliberate "not a violations-only list" design (see `../a11y-core/docs/OUTPUT_SCHEMA.md`). Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ page })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — a11y-core itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

### Getting a live element handle, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real Playwright `ElementHandle` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ page }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].elementHandle.screenshot({ path: 'flagged.png' });
await failing.occurrences[0].elementHandle.click();
```

This resolves `occurrence.selector` to an `ElementHandle` (via `page.$()`/`frame.$()`) instead of leaving you to re-resolve a possibly-stale selector string yourself. Default off — resolving a handle per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`. Combines with `.frames(true)`: each frame's occurrences resolve against that frame's own document. Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules) can carry `selector: ""`, in which case `occurrence.elementHandle` is `null` rather than a handle.

## Status and what's next

See `ROADMAP.md` — it documents what's built, what's verified, the known gaps vs. axe-core (prioritized, with reasoning), and exactly what to pick up next. Read it before starting new work here, especially in a fresh chat session that hasn't seen how this project came to exist.
