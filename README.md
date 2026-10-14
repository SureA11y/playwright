# @surea11y/playwright

A Playwright binding for [`@surea11y/core`](https://github.com/SureA11y/core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/playwright playwright
npx playwright install chromium   # every test launches a real browser -- npm install alone doesn't fetch it
```

`@surea11y/core` 1.11.1 or later comes with it as a peer dependency, as Playwright does: npm 7 and later, and pnpm 8 and later, install it for you, so the line above is all you need. With Yarn 1 or npm 6, which don't install peers, add `@surea11y/core` to that line.

Being a peer means your project and this binding share one copy of core. That matters as soon as your project uses core directly, to write a SARIF log or an HTML report (`@surea11y/core/sarif`, `/report`), read the rule catalogue, or keep a baseline: those read results with the same core that produced them, so a report never labels a finding with another release's rules. It holds when you bring your own core too: a linked checkout (`file:../core`), a monorepo, a fork, or a pinned release. Before 1.4.0, core was a regular dependency, and a project whose core differed from the binding's got a second copy without a word; such a project needed `"overrides": { "@surea11y/core": "$@surea11y/core" }` in its `package.json`, which it can now drop.

`npm test` (in this repo) only needs Chromium. The cross-browser regression tests in `tests/cross-browser.test.js` (proving this works against Firefox/WebKit too, not just Chromium) additionally need `npx playwright install firefox webkit`. `npm test` also compiles `tests/types/usage.ts` with TypeScript against the shipped types (`typescript` is a dev dependency only).

## Usage

```js
const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('@surea11y/playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com/');

const results = await new A11yCoreBuilder({ page })
  .include('#main')            // optional -- call multiple times for multi-region scans
  .exclude('.cookie-banner')    // optional
  .withWcag('2.2', 'AA')         // the rules for WCAG 2.2's A and AA criteria
  .disableRules(['meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
await browser.close();
```

`results` is `@surea11y/core`'s own native result shape — see its [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Every result says which `@surea11y/core` release produced it, in `results.engine.version` (for example `"1.11.1"`): quote it in a bug report, and compare it when two runs disagree.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

`.withWcag(version, level)` selects by conformance target: `.withWcag('2.2', 'AA')` runs the rules for WCAG 2.2's Level A and AA criteria, by the level each criterion has in that version (4.1.1 Parsing, which 2.2 removed, is part of a `'2.1'` target and not of a `'2.2'` one). `.withBestPractices()` adds the rules that name no WCAG criterion, such as `region` and `heading-order`; on its own it runs only those. `.withRules()` and `.withTags()` add to a target's rules, and the disable methods apply after. A version other than `'2.0'`, `'2.1'` or `'2.2'`, or a level other than `'A'`, `'AA'` or `'AAA'`, throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. Both need `@surea11y/core` 1.11 or later.

`withTags()`/`disableRules()` have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one.

The four take a string or an array of strings. `undefined` (a missing config value) or an empty string throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. A rule ID or tag the engine doesn't know is ignored, with a warning in the page's console, as long as another one in the list is known; when none is, `.analyze()` rejects with an `EngineError` (below), so a typo such as `.withTags(['wcag2.2aa'])` can't run no rules and pass.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()`/`withPacks()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()`/`.withWcag()`/`.withBestPractices()` are the exception: each call replaces the previous value instead of merging with it.

### When `.include()` matches nothing, or doesn't parse

An `.include()` selector that matches no element scans nothing: every rule reports `notApplicable`, and `results.contextMatch` says so (`{ elementCount: 0, unmatchedSelectors: ['#main'] }`). With several `.include()` calls, the ones that match are scanned and the others are listed in `unmatchedSelectors`. Without `.include()`, `contextMatch` is `null`. (Before `@surea11y/core` 1.10.0 such a selector fell back to the whole page, so a typo scanned everything.) Since a scan of nothing has no failures, a gate on `checksResults` alone would pass; `getScanGaps(results)` lists what a scan left out, and `formatFailures(results)` (below) prints it:

```js
const { A11yCoreBuilder, getScanGaps } = require('@surea11y/playwright');

const results = await new A11yCoreBuilder({ page }).include('#main').analyze();
const gaps = getScanGaps(results);
// [{ kind: 'context-not-found', selectors: ['#main'],
//    message: 'Nothing was scanned: the scan scope matched no element ("#main").' }]
```

Each gap has a `kind`: `'context-not-found'` (nothing was scanned), `'context-partly-not-found'` (some of several selectors matched nothing), `'custom-rule-skipped'` (a custom rule the engine could not run, one per rule, from `results.skippedCustomRules`), or `'pack-skipped'` (a pack that did not run, one per pack, from `results.skippedPacks`; see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)).

`.analyze()` also prints each gap with `console.warn`, once per scanned frame, prefixed with the frame's URL, for example `@surea11y/playwright (https://example.com/): Nothing was scanned: the scan scope matched no element ("#main").` The engine warns too, but in the page's console, which a Playwright run doesn't show. The warning doesn't fail anything: to fail a test on a gap, assert on `getScanGaps(results)` as below.

### Errors from the engine

When the engine refuses its input, `.analyze()` rejects with an `EngineError` (exported from this package) carrying the engine's `code`:

- `INVALID_RUN_ONLY`: none of the rule IDs given to `.withRules()`, or none of the tags given to `.withTags()`, is one the engine knows.
- `INVALID_CONTEXT_SELECTOR`: an `.include()` selector the browser can't parse; `err.selector` names it.
- `INVALID_ENGINE_OPTIONS`: with `.options({ strictOptions: true })`, an option the engine doesn't read or a value it can't use. The message names each, with the closest known option (`lcoale`: did you mean `locale`?). Without `strictOptions`, a likely typo is only warned about in the page's console.
- `PAGE_BUILTINS_BROKEN`: the page's own scripts broke a JavaScript built-in the engine relies on (`Array.prototype.filter`, `Map`, `JSON.stringify`, ...), so no result it gave could be trusted. The message names each one.

```js
const { A11yCoreBuilder, EngineError } = require('@surea11y/playwright');

try {
  await new A11yCoreBuilder({ page }).withTags(['wcag2.2aa']).analyze();
} catch (err) {
  if (err instanceof EngineError && err.code === 'INVALID_RUN_ONLY') {
    // runOnly.tags: no tag named "wcag2.2aa".
  }
  throw err;
}
```

Any other error (a closed page, a navigation during the scan) rejects as it always has.

This binding works against all three Playwright engines, not just Chromium — verified with real Firefox and WebKit runs, see `tests/cross-browser.test.js`.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real `@playwright/test` test (this is the pattern that actually matters for a CI/E2E suite, not just an ad hoc script):

```js
const { test, expect } = require('@playwright/test');
const { A11yCoreBuilder, formatFailures } = require('@surea11y/playwright');

test('page has no accessibility violations', async ({ page }) => {
  await page.goto('https://example.com/');

  const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();

  expect(results.checksResults, formatFailures(results)).toEqual([]);
});
```

To also fail when the scan left something out (an `.include()` that matched nothing, a custom rule or a pack that didn't run), assert on `getScanGaps(results)` too: `expect(getScanGaps(results), formatFailures(results)).toEqual([])`.

See `examples/playwright-test-example.spec.js` for a fuller, runnable version (`npm run example:e2e`) — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly.

### Readable console/CI output on failure

`expect(x).toEqual([])` alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(results)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/selector/hint) that you hand to your assertion library's own failure-message parameter, as above. A real failure then prints:

```
Error: 1) button-name-present (serious): This button has no accessible name.
   at main > button
   Give the button visible text, or name it with aria-label, so screen reader users know what it does.
2) img-alt-present (serious): This <img> has no alt attribute.
   at main > img
   Add an alt attribute that says what the image shows, or alt="" if the image is purely decorative.

Part of the scan scope was not scanned: no element matched "#sidebar".

Scanned with @surea11y/core 1.11.1.
```

Given the whole result, as here, it also lists what the scan left out (see `getScanGaps()` above; a scan whose `.include()` matched nothing never reads as "No accessibility violations found.") and ends with the core release that produced the result. It still accepts `results.checksResults` alone, without those two parts. A finding inside a shadow tree is located through its shadow hosts, as `my-app >>> my-card >>> img` (`formatOccurrenceLocation(occurrence)` gives that line on its own); that notation is for reading, not a selector `document.querySelector()` takes. For a `.frames(true)` scan, format `results.topFrame` and each frame on its own: both functions throw a `TypeError` for the `{ topFrame, frames }` shape rather than report it as clean.

...with Playwright's own raw diff still printed underneath (unavoidable — `toEqual` always includes it), but the readable summary now comes first, where it's actually useful. Deliberately a plain function, not a custom `expect` matcher — no dependency on any particular assertion library, so it works the same with Playwright's `expect`, Jest, Vitest, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the ones that report findings; a `notApplicable` rule can carry one occurrence saying why it had nothing to judge, which is left out); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

### Scanning every frame, including cross-origin iframes

```js
const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

Unlike script-injection-based accessibility tools (which need a `postMessage`-based protocol to reach cross-origin iframes, since they're injected as a plain `<script>` fully subject to the browser's same-origin policy), this needs no extra engine support at all — Playwright drives every frame via CDP at the automation-process level, so cross-origin `frame.evaluate()` already just works. Default off, so plain `.analyze()` is unaffected unless you opt in.

`results.frames` is a flat list of every sub-frame, however deeply nested. A frame that couldn't be scanned (it detached or navigated away mid-scan, or is sandboxed against scripts) is an entry `{ url, error }` instead of a result, so check for `error` before reading `checksResults`.

`@surea11y/core`'s reporters take this result as it is (core 1.11.1 and later): `renderSarifReport(results)`, `renderJunitReport(results)`, `renderHtmlReport(results)` and the baseline functions report every frame's findings, and a frame that couldn't be scanned as not scanned, so it never reads as a pass.

```js
const fs = require('node:fs');
const { renderSarifReport } = require('@surea11y/core/sarif');

const results = await new A11yCoreBuilder({ page }).frames(true).analyze();
fs.writeFileSync('a11y.sarif', renderSarifReport(results));
```

`.include()` scopes the top frame only: each sub-frame is scanned whole, as `@surea11y/core`'s own `runa11yCoreAcrossFrames` does. (A sub-frame rarely holds the element the top frame's selector names, and since core 1.10.0 a selector that matches nothing scans nothing.) `.exclude()` applies in every frame. An `EngineError` (above) rejects the whole scan, since the top frame is scanned first with the same rule and tag lists.

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — `@surea11y/core`'s own deliberate "not a violations-only list" design. Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ page })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — the engine itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

A result trimmed this way is no longer the whole scan to `@surea11y/core`'s reporters: JUnit counts one test per rule it finds, and EARL makes one assertion per rule. To keep a result small and still hand it to them, ask the engine for a compact one instead, with `.options({ output: { detail: 'findings' } })`: a rule that passed or did not apply keeps only its outcome, and every reporter reads it as the full result. An empty page's result goes from about 236 KB to 80 KB.

### Getting a live element handle, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real Playwright `ElementHandle` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ page }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].elementHandle.screenshot({ path: 'flagged.png' });
await failing.occurrences[0].elementHandle.click();
```

This resolves each occurrence to an `ElementHandle` in its own frame instead of leaving you to re-resolve a possibly-stale selector string yourself. An occurrence inside a shadow tree is found through its `shadowHostSelectors` (below), so the handle is the flagged element even when a plain `page.$(occurrence.selector)` would match another one elsewhere on the page. Default off — resolving a handle per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`. Combines with `.frames(true)`: each frame's occurrences resolve against that frame's own document. Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules) can carry `selector: ""`, in which case `occurrence.elementHandle` is `null` rather than a handle; so is an occurrence whose element (or a shadow host on the way to it) is gone by the time it is resolved.

Each `ElementHandle` holds a browser-side reference until garbage collected or explicitly disposed — for a scan with many violations that you're keeping around a while (rather than using immediately, as above), call `occurrence.elementHandle.dispose()` when you're done with it, per [Playwright's own `ElementHandle` guidance](https://playwright.dev/docs/api/class-elementhandle).

### Registering a custom rule at runtime

`@surea11y/core` supports registering additional rules per-scan via `engineOptions.customRules`. Use `.withCustomRules()` to register one:

```js
const results = await new A11yCoreBuilder({ page })
  .withCustomRules({
    id: 'my-org-custom-rule',
    meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
    // A real, live function is fine here -- .withCustomRules() converts it
    // to a function-source string for you (see below for why that matters).
    runInPage(ctx) {
      const el = ctx.document.querySelector('.my-widget');
      return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
    }
  })
  .analyze();
```

A custom rule descriptor is the same shape as one of `@surea11y/core`'s own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see its [`ENGINE_OPTIONS.md`](https://github.com/SureA11y/core/blob/main/docs/ENGINE_OPTIONS.md) for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan. A custom rule the engine can't run is listed in `results.skippedCustomRules` as `{ id, reason }`, and `getScanGaps()`/`formatFailures(results)` report it, instead of it looking like a rule that passed.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ page })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a Playwright `page.evaluate()` argument crosses a JSON boundary that can't carry a live function reference, only a string `@surea11y/core` can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you, so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a silently-skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to `@surea11y/core`'s own engine-side behavior, which skips an invalid descriptor rather than throwing, and lists it in `results.skippedCustomRules`.)

### Checking against EN 301 549

EN 301 549, the standard the European Accessibility Act refers to, restates WCAG's Level A and AA criteria in its chapter 9. `.options({ profile })` runs the rules for its version, and each finding carries its EN 301 549 clause beside its WCAG criterion, in `meta.normativeMappings` (WCAG 1.1.1 is clause 9.1.1.1):

```js
// EN 301 549 V4.1.1 (WCAG 2.2 A and AA); 'en301549-v3.2.1' for V3.2.1 (WCAG 2.1 A and AA)
const results = await new A11yCoreBuilder({ page })
  .options({ profile: 'en301549-v4.1.1' })
  .analyze();

results.engine.profile; // 'en301549-v4.1.1'
```

`.withWcag()`, `.withRules()` and `.withTags()` select rules instead of a profile, so leave them out when scanning with one. As with any target, a scan with no failures means no rule found a violation, not that the page conforms: most criteria need a person to check them. A profile name core doesn't know is not an error: the scan runs without it, core warns in the page's console, and `results.engine.profile` is left out.

### Scanning with packs: standards, checklists and your own rules

A pack brings rules, variants of core's rules, a standard or a checklist, and their profiles and messages, from a package of its own: a national standard such as RGAA, or your organisation's accessibility policy. `@surea11y/core` runs a pack as it runs its own rules and standards, so its results, rollups and report entries look like core's. Packs need `@surea11y/core` 1.11.1 or later.

`.withPacks()` registers packs in the page, and in every frame with `.frames(true)`, before the scan; a pack's profile is chosen with `.options({ profile })`:

```js
const acmePolicy = require('@acme/a11y-policy'); // a pack

const results = await new A11yCoreBuilder({ page })
  .withPacks(acmePolicy)
  .options({ profile: 'acme-web-2026' })
  .analyze();

results.engine.packs;   // ['@acme/a11y-policy@1.0.0']
results.engine.profile; // 'acme-web-2026'

// A checklist's items, each one result, beside core's WCAG rollups:
results.rulesResults.filter((r) => r.meta && r.meta.standard === 'Acme web policy');
```

A pack's own rules appear in `checksResults` like core's, with ids that start with its namespace (`acme-no-autoplay`). Without its profile, a pack's rules run only when selected, with `.withRules()` or by a tag. `@surea11y/core`'s HTML, SARIF and JUnit reports show a standard's or a checklist's items in a section of their own. Pass an array, or call `.withPacks()` again, to scan with several packs.

**Writing a pack.** A pack is an object made with `definePack` from `@surea11y/core/pack`. [`examples/acme-policy-pack.js`](./examples/acme-policy-pack.js) is a small one: a house rule, a checklist profile (WCAG 2.2 A and AA, `region`, and the house rule) and two checklist items. `npm run example:pack` scans a page with it, and [`examples/playwright-test-example.spec.js`](./examples/playwright-test-example.spec.js) uses it as a test gate. For a pack of your own, `npx surea11y-pack new <folder>` (from `@surea11y/core`) writes a package that works as generated, with its tests, docs and lint; core's [`PACKS.md`](https://github.com/SureA11y/core/blob/main/docs/PACKS.md) is the guide.

**When a pack doesn't run.** `.withPacks()` builds the page's script with the `@surea11y/core` this binding loads, and checks each pack as it does: `.analyze()` throws before scanning for a pack that core can't run, such as one whose `core` range leaves out the installed core, or whose profile names a rule that doesn't exist. A pack the page then doesn't run (one named with a raw `.options({ packs })` and never registered, or a page running another core version, when two copies of core are installed) is listed in `results.skippedPacks` with the reason. `getScanGaps()` reports that as `'pack-skipped'`, and `.analyze()` warns about it, so a test gate that asserts on `getScanGaps(results)` fails rather than passing with the pack's checks never run. Install the pack beside the binding, so npm resolves one core for both.

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `ElementHandle`. For an element inside a shadow tree, `selector` holds inside its shadow root, and `shadowHostSelectors` lists the shadow hosts that lead there, outermost first, each resolved in the tree that holds it. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships types for the whole builder API and the result (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.). The result types are built on the ones `@surea11y/core` ships, so they carry every field the engine returns (`engine.version`, `engine.environment`, `contextMatch`, `skippedCustomRules`, `shadowHostSelectors`, `margin`, ...); this package adds `elementHandle` and the `.frames(true)` shape. `EngineError`/`EngineErrorCode`, `getScanGaps()`/`ScanGap` and `formatOccurrenceLocation()` are typed too, and so are `withWcag()` (`WcagVersion`, `WcagLevel`) and `withPacks()`, which takes a pack made with `definePack` (`PackLike`). Code that handles every `ScanGap` kind it knows and treats the rest in an `else` branch needs a branch for `'pack-skipped'`, which carries `pack` rather than `selectors`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `playwright` is a `peerDependencies` entry (not just `devDependencies`) since the class's `page` argument and `Occurrence#elementHandle` both come from it — consumers need their own `playwright` install for the types to resolve, same as they already do to construct a `Page` in the first place.

## What changes with `@surea11y/core` 1.11

The binding passes rule IDs, tags and options through to the engine, so these show in results without a change here (see core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) for the full list):

- **Messages are reworded** in all five languages to say plainly what is wrong and what to do (`This <img> has no alt attribute.`). Message keys, rule IDs, reason codes and baselines are unchanged; a test that matches message text needs the new wording.
- **Contrast and target size measure what is on screen.** In a browser, the contrast rules check only text a reader can see, measure it against what is painted under it, and measure form field values and placeholders. `target-size-minimum` measures the area a pointer can hit, and exempts only links in a sentence. Expect new findings, and some old ones gone.
- **`aria-hidden-focus` maps to 4.1.2 only**, no longer to 2.4.7 Focus Visible, so `.withTags('wcag2aa')` alone no longer selects it.
- **A custom rule counts toward its WCAG criterion.** A `.withCustomRules()` rule with `meta.wcagSc` (or a WCAG `normativeMappings` entry) fails that criterion's rollup when it fails, and custom rules run after core's.
- **On/off options read as meant**: `.options({ perfStats: 'false' })` is off, where it was on. `.options({ strictOptions: true })` rejects any option the engine doesn't read (see [Errors from the engine](#errors-from-the-engine)).

## Building another framework binding?

See `@surea11y/core`'s [`BINDING_AUTHORS_GUIDE.md`](https://github.com/SureA11y/core/blob/main/docs/BINDING_AUTHORS_GUIDE.md) — a reference for building a new binding, covering which parity features are engine-level (work through a generic `.options()`/`runOnly` passthrough with zero binding code, including WCAG-version tag filtering) vs. binding-layer (element refs, `reportOnly`-style verbosity filtering, the `page.evaluate()` serialization-boundary caveat that `.withCustomRules()` exists to paper over).

`A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), a small shared package holding the scaffolding common to every framework binding. A new binding should depend on that package from the start.

## Maintainer

Maintained by [Jorge Rumoroso](https://github.com/rumoroso).

## License

MIT — see [`LICENSE`](./LICENSE).

This package depends on [`@surea11y/core`](https://github.com/SureA11y/core), which is MPL-2.0. MPL-2.0's copyleft is file-level and applies only to `@surea11y/core`'s own source files; consuming it as a normal package dependency doesn't affect this package's license.
