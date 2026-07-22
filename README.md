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

`withTags()`/`disableRules()` above have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way axe's `runOnly`/`disableRules` do, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (a11y-core's default `includeMode: 'and'` — see `../a11y-core/docs/ENGINE_OPTIONS.md`), not either one.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real `@playwright/test` test (this is the pattern that actually matters for a CI/E2E suite, not just an ad hoc script):

```js
const { test, expect } = require('@playwright/test');
const { A11yCoreBuilder } = require('a11y-core-playwright');

test('page has no accessibility violations', async ({ page }) => {
  await page.goto('https://example.com/');

  const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();

  expect(results.checksResults).toEqual([]);
});
```

See `examples/playwright-test-example.spec.js` for a fuller, runnable version (`npm run example:e2e`) — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly, and a loud failure message that names the broken rule(s) instead of a bare `toEqual` diff.

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

### Registering a custom rule at runtime

`a11y-core` supports registering additional rules per-scan via `engineOptions.customRules` — this binding has no dedicated builder method for it yet, but the existing `.options()` passthrough already forwards it, so it works today:

```js
const results = await new A11yCoreBuilder({ page })
  .options({
    customRules: [{
      id: 'my-org-custom-rule',
      meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
      // Must be a function-source STRING here, not a live function --
      // engineOptions crosses a page.evaluate() JSON boundary that can't
      // carry a live Function reference, only a string it can reconstruct.
      runInPage: (function (ctx) {
        const el = ctx.document.querySelector('.my-widget');
        return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
      }).toString()
    }]
  })
  .analyze();
```

A custom rule descriptor is the same shape as one of a11y-core's own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see `../a11y-core/docs/ENGINE_OPTIONS.md` for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `ElementHandle`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See `../a11y-core/docs/OUTPUT_SCHEMA.md` for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships hand-written types for the whole builder API plus a11y-core's native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.), mirrored from `../a11y-core/docs/OUTPUT_SCHEMA.md`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `playwright` is a `peerDependencies` entry (not just `devDependencies`) since the class's `page` argument and `Occurrence#elementHandle` both come from it — consumers need their own `playwright` install for the types to resolve, same as they already do to construct a `Page` in the first place.

## Status and what's next

See `ROADMAP.md` — it documents what's built, what's verified, the known gaps vs. axe-core (prioritized, with reasoning), and exactly what to pick up next. Read it before starting new work here, especially in a fresh chat session that hasn't seen how this project came to exist.
