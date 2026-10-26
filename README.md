# @surea11y/playwright

A Playwright binding for [`@surea11y/core`](https://github.com/SureA11y/core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/core @surea11y/playwright playwright
npx playwright install chromium   # every test launches a real browser -- npm install alone doesn't fetch it
```

`@surea11y/core` 1.12.0 or later, the engine, comes with the binding as a regular dependency, so a project that doesn't list it still works. List it in your own `package.json` too, as the line above does: your project and the binding then share one copy, so whatever you do with core directly, writing a SARIF log or an HTML report (`@surea11y/core/sarif`, `/report`), reading the rule catalogue or keeping a baseline, reads results with the same core that produced them. When your core can't match the binding's range, as with a linked checkout (`file:../core`) or a fork, add `"overrides": { "@surea11y/core": "$@surea11y/core" }` beside it.

**Coming in 2.0:** core becomes a peer dependency, so the binding will no longer install it for you, and the `overrides` entry is no longer needed. Add `@surea11y/core` to your `package.json` now and 2.0 needs no change.

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

Every result says which `@surea11y/core` release produced it, in `results.engine.version` (for example `"1.12.0"`): quote it in a bug report, and compare it when two runs disagree. From 1.4.0 this package needs `@surea11y/core` 1.12.0 or later; see [What changes with `@surea11y/core` 1.12](#what-changes-with-surea11ycore-112).

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

`.withWcag(version, level)` selects by conformance target: `.withWcag('2.2', 'AA')` runs the rules for WCAG 2.2's Level A and AA criteria, by the level each criterion has in that version (4.1.1 Parsing, which 2.2 removed, is part of a `'2.1'` target and not of a `'2.2'` one). `.withBestPractices()` adds the rules that name no WCAG criterion, such as `region` and `heading-order`; on its own it runs only those. `.withRules()` and `.withTags()` add to a target's rules, and the disable methods apply after. The level is read in any case (`'aa'` is `'AA'`). A version other than `'2.0'`, `'2.1'` or `'2.2'`, or a level other than A, AA or AAA, throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. Both need `@surea11y/core` 1.11 or later.

`withTags()`/`disableRules()` have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one, unless you ask for that with `.includeMode('or')` (below).

`.includeMode(mode)` decides how `.withRules()` and `.withTags()` combine when both are given: `'and'`, the default, runs only the rules that match both, and `'or'` runs those that match either. That's what lets a scan say "this area, plus these checks". A team that owns a design system's form components, say, can run every rule about forms and the contrast check too, in one scan:

```js
const results = await new A11yCoreBuilder({ page })
  .withTags('forms')
  .withRules('contrast-computable')
  .includeMode('or')             // every forms rule, plus the contrast check
  .analyze();
```

Without `.includeMode('or')`, the same lines run no rule at all, since `contrast-computable` isn't tagged `forms`, and a scan of no rules looks clean. The same goes for a WCAG level tag beside a best practice: `.withTags('wcag2a').withRules('region')` runs nothing, and with `'or'` runs the `wcag2a` rules plus `region`. On its own, with no other selection, it changes nothing. A value other than `'and'` or `'or'` throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. A `.withWcag()` target doesn't need it: its rules are always added to what tags and rules select.

`.wcagLevel(level)` sets the WCAG level of the criteria a scan reports, without changing which rules run: criteria above it are left out of `results.rulesResults`, while every selected rule still runs and reports in `results.checksResults`. It's what lets a scan that names a few checks say it is meant as WCAG AA. A team that gates each pull request on colour contrast alone, say, runs one check, which covers both 1.4.3 (AA) and 1.4.6 (AAA):

```js
const results = await new A11yCoreBuilder({ page })
  .withRules('contrast-computable')
  .wcagLevel('AA')               // report 1.4.3, not the AAA 1.4.6
  .analyze();
```

Without `.wcagLevel('AA')`, that scan reports 1.4.6 as well, so a site that meets AA can show a failing AAA criterion it never aimed for. With it, the scan reports 1.4.3 alone, and `results.engine.wcagLevel` says `'AA'`. A `.withWcag()` target already implies its level; `.wcagLevel()` is for selections that don't, and wins when both are given, as it does over a level given through `.options()`. `'A'`, `'AA'` or `'AAA'` in any case is accepted. Anything else throws a `TypeError` with `code: 'INVALID_ENGINE_OPTIONS'` at the call, and `null` clears it. Needs `@surea11y/core` 1.12.0 or later.

`.plannedChecks()` and `.plannedCriteria()` say what a scan *will* check before you run it: the rules it runs (entries with `ruleId`) and the criteria it reports in `rulesResults` (entries with `id`), worked out in Node from the same selection and options, with no page. Use them to record what a run covered next to its result, or to catch a selection that runs nothing, which would otherwise look like a clean scan:

```js
const builder = new A11yCoreBuilder({ page }).withTags('forms').withRules('contrast-computable');
if (builder.plannedChecks().length === 0) {
  throw new Error('This selection runs no rule. Did you mean .includeMode("or")?');
}
const results = await builder.analyze();
```

The four take a string or an array of strings. `undefined` (a missing config value) or an empty string throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. A rule ID or tag the engine doesn't know is ignored, with a warning in the page's console, as long as another one in the list is known; when none is, `.analyze()` rejects with an `EngineError` (below), so a typo such as `.withTags(['wcag2.2aa'])` can't run no rules and pass.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()`/`withPacks()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()`/`.screenshots()`/`.withWcag()`/`.withBestPractices()`/`.includeMode()`/`.wcagLevel()`/`.logger()` are the exception: each call replaces the previous value instead of merging with it.

### When `.include()` matches nothing, or doesn't parse

An `.include()` selector that matches no element scans nothing: every rule reports `notApplicable`, and `results.contextMatch` says so (`{ elementCount: 0, unmatchedSelectors: ['#main'] }`). With several `.include()` calls, the ones that match are scanned and the others are listed in `unmatchedSelectors`. Without `.include()`, `contextMatch` is `null`. (Before `@surea11y/core` 1.10.0 such a selector fell back to the whole page, so a typo scanned everything.) Since a scan of nothing has no failures, a gate on `checksResults` alone would pass; `getScanGaps(results)` lists what a scan left out, and `formatFailures(results)` (below) prints it:

```js
const { A11yCoreBuilder, getScanGaps } = require('@surea11y/playwright');

const results = await new A11yCoreBuilder({ page }).include('#main').analyze();
const gaps = getScanGaps(results);
// [{ kind: 'context-not-found', selectors: ['#main'],
//    message: 'Nothing was scanned: the scan scope matched no element ("#main").' }]
```

Each gap has a `kind`: `'context-not-found'` (nothing was scanned), `'context-partly-not-found'` (some of several selectors matched nothing), `'custom-rule-skipped'` (a custom rule the engine could not run, one per rule, from `results.skippedCustomRules`; one you excluded yourself with `.disableRules()` is not a gap), or `'pack-skipped'` (a pack that did not run, one per pack, from `results.skippedPacks`; see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)).

`.analyze()` also prints each gap with `console.warn`, once per scanned frame, prefixed with the frame's URL, for example `@surea11y/playwright (https://example.com/): Nothing was scanned: the scan scope matched no element ("#main").` The engine warns too, but in the page's console, which a Playwright run doesn't show. The warning doesn't fail anything: to fail a test on a gap, assert on `getScanGaps(results)` as below.

That warning is the right default for a test run. A project that already handles gaps itself can take them over with `.logger(fn)`: `fn(gap, result)` is called once per gap, with the gap as `getScanGaps()` gives it and the result of the frame it came from, instead of `console.warn`. A scanning service that shows gaps to its users, say, can send them once to its own structured log, rather than also printing a loose line on the server's console for every scan:

```js
const results = await new A11yCoreBuilder({ page })
  .include('#checkout')
  .logger((gap, frame) => log.warn({ url: frame.url, kind: gap.kind }, gap.message))
  .analyze();
```

A batch job that writes `getScanGaps(results)` into its own report can pass `.logger(() => {})` to keep its output to the report, and `.logger(null)` brings `console.warn` back. Anything other than a function or `null` throws a `TypeError` at the call, and a later call replaces the logger. Either way, `getScanGaps(results)` still lists every gap.

`getScanNotes(results)` says how the page was scanned, which a gap doesn't cover, and nothing was left out: `'forced-colors'` when the page was shown in [forced colors](#forced-colors), `'internals-hook'` when the scan asked about web components it could have read with the [internals hook](#web-components-the-internals-hook), and `'listener-hook'` or `'live-region-hook'` when findings that the [listener hook](#click-handlers-added-from-script-the-listener-hook) or the [live-region hook](#live-regions-the-live-region-hook-and-announcements) would have decided were judged without it (with `findingCount` and the `rules`). `.analyze()` also prints each hook note, once per scan, and a `.logger()` receives it (check `kind` to tell a note from a gap).

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

### Failing only on serious problems

Every rule result has a severity: `critical`, `serious`, `moderate` or `minor` (a profile can set its own). To start by blocking on serious problems while the rest are still reported, gate on `getGatingFailures(results, { failOnSeverity })` (`@surea11y/binding-base` 1.6.0 and later): the failing rules at that level or above, the same ones `surea11y scan --fail-on-severity` counts for the page. `formatFailures()` takes the same option and still lists the failures below the level, marked as ones that don't fail the test.

```js
const { A11yCoreBuilder, formatFailures, getGatingFailures } = require('@surea11y/playwright');

const results = await new A11yCoreBuilder({ page }).analyze();
const gate = { failOnSeverity: 'serious' };
expect(getGatingFailures(results, gate), formatFailures(results, gate)).toEqual([]);
```

`fail` keeps its meaning, a definite violation; the level only picks which failures stop the test, and every failure stays in `results`. A level that isn't one of the four throws a `TypeError`. `SEVERITIES` lists them, least to most severe.

### Readable console/CI output on failure

`expect(x).toEqual([])` alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(results)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/selector/hint) that you hand to your assertion library's own failure-message parameter, as above. Each occurrence is read by its own outcome, and the list follows the order a review takes: failures first, then the [questions](#findings-that-need-review-leans-and-how-to-check) that likely fail, those that likely pass, and those only a person can answer. A real failure then prints:

```
Error: 1) button-name-present (serious): This button has no accessible name.
   at main > button
   Give the button visible text, or name it with aria-label, so screen reader users know what it does.
2) img-alt-present (serious): This <img> has no alt attribute.
   at main > img
   Add an alt attribute that says what the image shows, or alt="" if the image is purely decorative.

Part of the scan scope was not scanned: no element matched "#sidebar".

Scanned with @surea11y/core 1.12.0.
```

Given the whole result, as here, it also lists what the scan left out (see `getScanGaps()` above; a scan whose `.include()` matched nothing never reads as "No accessibility violations found.") and its notes (`getScanNotes()`, such as a page shown in forced colors), and ends with the core release that produced the result. It still accepts `results.checksResults` alone, without those two parts. A finding inside a shadow tree is located through its shadow hosts, as `my-app >>> my-card >>> img` (`formatOccurrenceLocation(occurrence)` gives that line on its own); that notation is for reading, not a selector `document.querySelector()` takes. For a `.frames(true)` scan, format `results.topFrame` and each frame on its own: both functions throw a `TypeError` for the `{ topFrame, frames }` shape rather than report it as clean.

...with Playwright's own raw diff still printed underneath (unavoidable — `toEqual` always includes it), but the readable summary now comes first, where it's actually useful. Deliberately a plain function, not a custom `expect` matcher — no dependency on any particular assertion library, so it works the same with Playwright's `expect`, Jest, Vitest, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the ones that report findings; a `notApplicable` rule can carry one occurrence saying why it had nothing to judge, which is left out); pass `{ outcomes: [...] }` to narrow further, by outcome or by review group (`'leanFail'`, `'leanPass'`, `'open'`), and `{ howToCheck: true }` to list each question's steps (see [below](#findings-that-need-review-leans-and-how-to-check)). An outcome it doesn't know throws a `TypeError`. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

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

### A picture of each failing element

Opt in with `.screenshots()`, and each occurrence the scan flags gets a `screenshot` field: a picture of the element, with a box drawn around it, or the reason there is none.

```js
const results = await new A11yCoreBuilder({ page })
  .screenshots({ dir: 'a11y-shots', padding: 16 })
  .analyze();

const [first] = results.checksResults.filter((r) => r.outcome === 'fail');
first.occurrences[0].screenshot;
// { path: 'a11y-shots/element-3f9a1c07.png', box: { x: 20, y: 20, width: 120, height: 40 } }
```

| Option | Default | |
|---|---|---|
| `dir` | none | Write each picture there. Without it, each comes back as `{ buffer, box }`, a PNG for you to store your own way. |
| `outcomes` | `['fail']` | Which occurrences to picture. For contrast, `['fail', 'cantTell']` shows the background the engine couldn't judge. |
| `padding` | `0` | CSS pixels of context around the element. |
| `highlight` | `true` | Draw a box around the element, over the page; the element itself is never restyled. |
| `max` | `50` | At most this many pictures per scan, frames included. |

- **One picture per element.** Several rules can flag the same element; it's pictured once, and each of their occurrences carries the same `screenshot`. A file is named after where the element is, so it keeps its name from run to run, and `formatFailures()` names it under each finding (`   screenshot: a11y-shots/element-3f9a1c07.png`).
- **`box`** is where the element shows in the picture, in CSS pixels; the PNG is larger by the device pixel ratio. `cropped: true` says only part of it shows, as for an element taller than the viewport, which is pictured from its top-left corner.
- **No picture, and why**: `{ skipped }` with `'no-element'` (no selector, or nothing matches it any more), `'page-level'` (a finding about the whole page, on `<html>`, `<head>` or `<body>`), `'not-rendered'` (such as `display: none`), `'zero-size'`, `'off-screen'` (such as `left: -9999px`), `'max-reached'`, or `'capture-failed'` with the browser's `error`. A failed picture never fails the scan.
- **The page is put back.** Each element is scrolled into view for its picture, and afterwards every scroll position is restored and the box removed, also when a picture fails. Something drawn over the element, such as a sticky header, shows as it does on screen.
- **Frames.** With `.frames(true)`, an element in an `<iframe>`, cross-origin ones included, is pictured on the page as it shows there.
- **Off by default.** Pictures of real pages can hold personal data, and they end up as CI artifacts.

The pictures are taken right after each frame's scan, before `.reportOnly()` trims the result, and combine with `.elementRef(true)`. Focus, hover, animations or content that loads late can still differ from what the scan saw. An option it can't use throws a `TypeError` with `code: 'INVALID_ENGINE_OPTIONS'` at the call, and so does `.analyze()` with `options({ output: { includeSelector: false } })`, since each element is found by its selector. Works in Chromium, Firefox and WebKit.

### Findings that need review: leans and how to check

A `cantTell` is a question for a person: the engine couldn't prove the answer from the page. With `@surea11y/core` 1.14, a question says more:

- **Which way it leans.** Where the page's evidence points one way, the occurrence has a `lean`: `toward` (`'fail'` or `'pass'`), `why`, and sometimes a `caution` saying what could make it wrong. A skipped heading level leans fail; `aria-checked` on a native checkbox leans pass. A lean counted against the W3C ACT test cases on five cases or more also says how often it was right (`measured`). The outcome stays `cantTell` either way. See core's [`LEANS.md`](https://github.com/SureA11y/core/blob/main/docs/LEANS.md).
- **How to check it.** Each question of a core rule carries `howToCheck`: `steps` starting from the element it names, and what a person sees if it passes (`passWhen`) or fails (`failWhen`), in the scan's locale. The engine in the page leaves them out; `.analyze()` adds them, with the steps of your packs' rules too.

`formatFailures()` shows both: each question says beside its severity whether it likely fails, likely passes or needs review, then why, the caution, and with `{ howToCheck: true }` the steps:

```
2) heading-order (minor, likely fails): This heading jumps from level 1 to level 3, skipping a level.
   at html > body > main > h3
   Go down one level at a time, so an <h2> is followed by an <h3> rather than an <h4>, and the outline of the page stays easy to follow.
   Why it likely fails: The heading skips a level after the one before it.
   How to check:
     1. Find the heading the report names and note its level and the previous heading's level (from the report or the Accessibility pane).
     ...
```

To gate a test on the questions that likely fail as well as the failures, use `@surea11y/core`'s `leaningFailures(results)`, which works on this binding's results (a `.frames(true)` tree included). It leaves out the rules whose criteria are outside the scan's target, and with `{ wcagOnly: true }` the best-practice rules too:

```js
const { test, expect } = require('@playwright/test');
const { leaningFailures } = require('@surea11y/core');
const { A11yCoreBuilder, formatFailures } = require('@surea11y/playwright');

test('no failures, and no questions that likely fail', async ({ page }) => {
  await page.goto('https://example.com/');

  const results = await new A11yCoreBuilder({ page }).analyze();
  const failures = results.checksResults.filter((r) => r.outcome === 'fail');
  expect(
    [...failures, ...leaningFailures(results)],
    formatFailures(results, { outcomes: ['fail', 'leanFail'] })
  ).toEqual([]);
});
```

Don't trim such a result with `.reportOnly(['fail'])` first: it drops the `cantTell` rules, and their leans with them. `.reportOnly()` filters whole rules by their outcome, while a rule's occurrences can sit in different tiers (`occurrenceOutcome`), which `formatFailures()` reads one by one. For CI reports, core's `renderJunitReport(results, { leanFailAs: 'failure' })` and `renderSarifReport(results, { leanFailAs: 'error' })` gate on the same findings, and both carry the steps.

### Web components: the internals hook

Many web components keep their `ElementInternals` in a private field and name themselves, set their states or give themselves a role through it:

```js
class SubscribeCheckbox extends HTMLElement {
  #internals = this.attachInternals();
  constructor() {
    super();
    this.#internals.ariaLabel = 'Subscribe';
    this.#internals.ariaChecked = 'false';
  }
}
```

The browser exposes that name, but no page script can read it back, so by default the scan asks about such a component (`cantTell`) instead of judging it. A component that's a `switch` only through `this.#internals.role` isn't even asked about: the scan doesn't see its role, so it isn't checked at all.

`A11yCoreBuilder.installInternalsHook(pageOrContext)` installs `@surea11y/core`'s opt-in hook, which records each component's internals for the scan to read. Call it **before** `page.goto()`, on the page, or on its browser context to cover every page the context opens:

```js
const context = await browser.newContext();
await A11yCoreBuilder.installInternalsHook(context); // before any page navigates
const page = await context.newPage();
await page.goto('https://example.com/');

const results = await new A11yCoreBuilder({ page }).analyze();
results.engine.environment.internalsHook; // 'early': the hook ran before the page's scripts
```

With `@playwright/test`, install it in a `beforeEach` on the `context` fixture, or on `page` before the test navigates.

With it, the checkbox above passes, an unnamed component that attaches internals fails like any unnamed control, and the switch is checked as a switch, so it fails without a name. Playwright runs init scripts (`addInitScript()`) before the page's own scripts in every frame, and again after each navigation, so one call covers a page or context for its lifetime. It works in Chromium, Firefox and WebKit.

- **Before the page loads.** On a page that's already loaded, the call has no effect until the next navigation (a reload will do), and the result has no `internalsHook`.
- **For test and audit runs.** The hook wraps `HTMLElement.prototype.attachInternals` (components get the same internals back), adds a stack frame to errors thrown through it, and keeps its record under a global symbol, where any script on the page can read every component's internals. That's why it's opt-in.
- **Without it**, `.analyze()` says so once per scan when it asked about such components (`1 custom element was asked about because the scan could not read...`), and `getScanNotes()` gives that note as `kind: 'internals-hook'`.

### Click handlers added from script: the listener hook

Most pages add their click handlers from script, where no page script can list them afterwards:

```html
<div class="save" role="button" tabindex="0">Save</div>
<script>
  document.querySelector('.save').addEventListener('click', save);
</script>
```

Enter and Space don't fire `click` on a `<div>`, so this button does nothing from the keyboard. Without help the scan can't see the listener, so `click-handler-keyboard-operable` doesn't report the element at all. `A11yCoreBuilder.installListenerHook(pageOrContext)` installs `@surea11y/core`'s opt-in listener hook (core 1.14.0 and later), which records the click, key, focus and mouse listeners a page adds, so the keyboard rules judge them. Call it **before** `page.goto()`, on the page or its browser context, as the internals hook:

```js
const context = await browser.newContext();
await A11yCoreBuilder.installListenerHook(context); // before any page navigates
const page = await context.newPage();
await page.goto('https://example.com/');

const results = await new A11yCoreBuilder({ page }).analyze();
results.engine.environment.listenerHook; // 'early'
```

With `@playwright/test`, install it in a `beforeEach` on the `context` fixture, or on `page` before the test navigates.

With it, the button above fails (`CLICK_HANDLER_NO_KEY_LISTENER`: no key listener anywhere a key event from it goes), and `mouse-only-event-handlers` and `widget-keyboard-focusable` count the listeners too. Only a hook installed before the page's scripts (`'early'`) proves a listener is missing; one installed later is `'late'`, and the rules then only ask. It wraps `addEventListener`, `removeEventListener` and the `on…` setters, with the page getting the same results and errors, and keeps its record under a global symbol: install it for test and audit runs. Without it, `getScanNotes()` gives a `'listener-hook'` note when findings it would have decided were judged without it. Core's [`INTEGRATION.md`](https://github.com/SureA11y/core/blob/main/docs/INTEGRATION.md#seeing-listeners-added-from-script-the-listener-hook) has the details, and its binding authors' guide the reason codes each hook decides.

### Live regions: the live-region hook and announcements()

`A11yCoreBuilder.installLiveRegionHook(pageOrContext)` installs `@surea11y/core`'s opt-in live-region hook (core 1.14.0 and later), which records what the page's live regions are given while it runs. The scan then asks about a region added with its text already in it, and one shown and filled at once, which screen readers commonly don't announce. And `A11yCoreBuilder.announcements(page)` returns what the page made available to announce, so a test can check that an action told the user something:

```js
const { test, expect } = require('@playwright/test');
const { A11yCoreBuilder } = require('@surea11y/playwright');

test.beforeEach(async ({ context }) => {
  await A11yCoreBuilder.installLiveRegionHook(context); // before the test navigates
});

test('saving says so', async ({ page }) => {
  await page.goto('https://example.com/settings');
  await page.getByRole('button', { name: 'Save' }).click();

  const said = await A11yCoreBuilder.announcements(page);
  // [{ text: 'Saved', politeness: 'polite', time: 1234.5, order: 7, behindModal: false, selector: '#status' }]
  expect(said.map((a) => a.text)).toContain('Saved');
});
```

Each entry names its region by `selector` (and `shadowHostSelectors` inside a shadow root; `null` for a region that has since left the page, such as a toast). It's `null` without the hook. A text given to a region behind an open modal dialog, which assistive technology did not get, is left out unless you pass `{ includeBehindModal: true }`, and comes marked `behindModal: true`. This is what the page made available to announce, not what a screen reader said. `announcements()` reads the page's top frame. The hook only observes, with one `MutationObserver`; see core's [`INTEGRATION.md`](https://github.com/SureA11y/core/blob/main/docs/INTEGRATION.md#seeing-what-live-regions-are-given-the-live-region-hook).

### Forced colors

A page shown in forced colors (Windows high contrast) draws in the user's colors, not its own. `results.engine.environment.forcedColors` says which it was: `'active'` or `'none'`. To check a page under forced colors on purpose, emulate it before scanning, in Chromium, Firefox or WebKit:

```js
await page.emulateMedia({ forcedColors: 'active' });
const results = await new A11yCoreBuilder({ page }).analyze();
results.engine.environment.forcedColors; // 'active'
```

`browser.newContext({ forcedColors: 'active' })` does the same for a whole context, and `@playwright/test` takes it as a `use` option. The contrast rules still measure the page's own colors under forced colors, since WCAG judges contrast in those, so results match a scan with forced colors off; a contrast finding the engine couldn't measure that way carries `details.forcedColors: true`. When forced colors were active, `formatFailures()` adds a line saying so, since it's easy to miss on a CI agent with high contrast turned on.

### Dark mode and phone width: scans under conditions

A page can fail differently in dark mode or at phone width: text that reads well on white fails contrast on a dark background, and a target big enough at 1280 pixels shrinks at 320. `.conditions()` scans the page as it is, then under each condition, and returns one result:

```js
const results = await new A11yCoreBuilder({ page })
  .conditions([{ colorScheme: 'dark' }, { width: 320 }, { colorScheme: 'dark', width: 320 }])
  .analyze();
```

A condition sets a color scheme (`'light'` or `'dark'`, with `page.emulateMedia()`), a viewport width in CSS pixels (with `page.setViewportSize()`, keeping the height), or both. The viewport and color scheme are put back after the last scan, even when one throws.

- A rule's outcome is its worst across the scans, so a contrast failure only in dark mode fails the rule.
- An occurrence is listed once per element, rule and reason code, with the `conditions` it appeared under (`['default', 'dark']`); `formatFailures()` prints them as `seen in: default, dark`.
- `results.conditionRuns` lists each scan's condition and `engine.environment`.

Each condition is a full scan, so three conditions take about four times as long as one scan. `.frames(true)` can't be combined with `.conditions()` yet. A picture taken with `.screenshots()` under a condition has the condition in its file name.

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

A custom rule you turn off for one scan (`.withCustomRules(rules).disableRules('org-banner-text')`) is listed in `skippedCustomRules` with `excluded: true` and isn't a scan gap, so it isn't warned about (core 1.12.0 and later).

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

Install a published pack in your project, beside core and this package:

```bash
npm install @surea11y/core @surea11y/playwright playwright @acme/a11y-policy
```

Your project, this package and the pack then share one copy of core, so the core that checks the pack is the one that runs it. With two copies, a scan can skip the pack (see "When a pack doesn't run" below).

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

**When a pack doesn't run.** `.withPacks()` builds the page's script with the `@surea11y/core` this binding loads, and checks each pack as it does: `.analyze()` throws before scanning for a pack that core can't run, such as one whose `core` range leaves out the installed core, or whose profile names a rule that doesn't exist. A pack the page then doesn't run (one named with a raw `.options({ packs })` and never registered, or a page running another core version, when two copies of core are installed) is listed in `results.skippedPacks` with the reason. `getScanGaps()` reports that as `'pack-skipped'`, and `.analyze()` warns about it, so a test gate that asserts on `getScanGaps(results)` fails rather than passing with the pack's checks never run.

### Style sheets from another origin

A page's script can't read the rules of a style sheet served from another origin (a CDN, a fonts service), so a check that reads the CSS, such as `css-orientation-lock`, can't tell whether it holds an orientation lock and asks about it. With `@surea11y/core` 1.14.0 or later, `.analyze()` asks the page which sheets it can't read, fetches them from Node with the page's own request API (so the page's cookies go with them), and gives core their text, which it then checks. It's on by default, as axe fetches such sheets; each request is given up after five seconds, and a sheet that can't be fetched leaves the check asking as before. To send no request but the page's own:

```js
await new A11yCoreBuilder({ page }).fetchStyleSheets(false).analyze();
```

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `ElementHandle`. For an element inside a shadow tree, `selector` holds inside its shadow root, and `shadowHostSelectors` lists the shadow hosts that lead there, outermost first, each resolved in the tree that holds it. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships types for the whole builder API and the result (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.). The result types are built on the ones `@surea11y/core` ships, so they carry every field the engine returns (`engine.version`, `engine.environment`, `contextMatch`, `skippedCustomRules`, `shadowHostSelectors`, `margin`, ...); this package adds `elementHandle`, `screenshot` (`OccurrenceScreenshot`) and the `.frames(true)` shape. `EngineError`/`EngineErrorCode`, `getScanGaps()`/`ScanGap`, `getScanNotes()`/`ScanNote` and `formatOccurrenceLocation()` are typed too, and so are `withWcag()` and `wcagLevel()` (`WcagVersion`, `WcagLevelInput`), `plannedChecks()`/`plannedCriteria()` (`PlannedCheck`, `PlannedCriterion`), the static `installInternalsHook()`, `installListenerHook()` and `installLiveRegionHook()` (each taking a `Page` or a `BrowserContext`) and `announcements(page)`, which resolves to `LocatedAnnouncement[] | null`, `formatFailures()`'s review groups (`ReviewGroup`) and `howToCheck` option, `withPacks()`, which takes a pack made with `definePack` (`PackLike`), and `.screenshots()` (`ScreenshotOptions`). Code that handles every `ScanGap` kind it knows and treats the rest in an `else` branch needs a branch for `'pack-skipped'`, which carries `pack` rather than `selectors`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `playwright` is a `peerDependencies` entry (not just `devDependencies`) since the class's `page` argument and `Occurrence#elementHandle` both come from it — consumers need their own `playwright` install for the types to resolve, same as they already do to construct a `Page` in the first place.

## What changes with `@surea11y/core` 1.14

With `@surea11y/core` 1.14.0, what a scan through this binding shows differently (core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) has the full list):

- **No WCAG criterion passes yet.** A criterion's rollup passes only when its rules check everything it asks, and none is listed as checked in full yet, so where its rules all pass it is `cantTell` (`composite.rollup.cantTell.partialCheck`). A rollup whose rules all found nothing is `notApplicable` only for 2.4.3, 2.4.4, 2.4.7, 2.4.9, 2.5.3 and 4.1.1, whose rules find every case, and `cantTell` otherwise (`composite.rollup.cantTell.partialCoverage`). A gate that asserted a criterion `pass` or `notApplicable` now sees `cantTell`; gate on `fail`, as `getGatingFailures()` does.
- **More questions.** `page-title-patterns` asks about every page title, so 2.4.2 is `cantTell` on a page with one, and `duplicate-id` asks about 4.1.1 under WCAG 2.0 and 2.1 too.
- **Questions lean, and say how to answer them.** A `cantTell` occurrence can carry a `lean` (which way the evidence points, and why) and carries `howToCheck` (the steps to answer it), which `.analyze()` adds. `formatFailures()` lists findings in the order a review takes and shows both. [More](#findings-that-need-review-leans-and-how-to-check).
- **New rules.** `widget-keyboard-focusable` (2.1.1) asks about a widget Tab never reaches. `click-handler-keyboard-operable` (2.1.1, 2.1.3) fails a `role="button"`, `link`, `checkbox` or `switch` with a click handler that nothing can bring keyboard focus to, and asks about one with no key handler. `focus-not-removed-by-script` (2.1.1, 2.4.7) fails an element whose `onfocus` only blurs it. `moving-content-pausable` (2.2.2) asks about content an animation moves for more than five seconds. `invalid-field-error-message` (3.3.1) asks about a field marked `aria-invalid` whose error message can't be reached. `live-region-announcements` (4.1.3) asks about a live region hidden with `aria-hidden` or `inert`, or left `aria-busy`. `aria-owns-valid` (1.3.1, 4.1.2) fails an element owned twice. `aria-expanded-state-mismatch` (4.1.2) asks about `aria-expanded` that contradicts what its `aria-controls` names, `image-of-text` (1.4.5) whether text drawn in an image could be real text, and the best practices `label-for-valid` and `control-name-title-only` about a `<label for>` that labels nothing and a control named only by its `title`.
- **Two more opt-in hooks.** With [`installListenerHook()`](#click-handlers-added-from-script-the-listener-hook), the keyboard rules judge click listeners added with `addEventListener`, and fail a focusable control no key listener can reach (`CLICK_HANDLER_NO_KEY_LISTENER`). With [`installLiveRegionHook()`](#live-regions-the-live-region-hook-and-announcements), `live-region-announcements` also asks about a region added with its text or shown and filled at once, and `A11yCoreBuilder.announcements(page)` returns what the page made available to announce.
- **Style sheets from another origin are checked.** `.analyze()` fetches, from Node, the style sheets the page can't read and core checks them, so `css-orientation-lock` finds a lock in a CDN's CSS instead of asking (`.fetchStyleSheets(false)` turns it off). [More](#style-sheets-from-another-origin).
- **Contrast is measured on more of what the page draws:** text on a page with no background in each color scheme it can be drawn in, `::first-line` and `::first-letter`, `font-size-adjust`, outlined and shadowed text, solid background layers and drop shadows it used to ask about. A placeholder whose colors the page chose fails below the ratio; in the browser's own colors it isn't reported.
- **Roles, names and hidden content follow browsers more closely**, among them `aria-allowed-attr` on a text input with a `<datalist>` (a combobox) and on `<td>`, every associated `<label>` joined into a name, and `hidden` that the page's CSS displays again hiding nothing.
- **A selector at the top of a shadow root** is now written so it can't match a sibling outside it (`img:not(* > *)`), so the selector a result gives, and `elementRef(true)`, point at the right element.
- **Some reason codes are split by cause** (`LIST_ITEM_ROLE_OVERRIDDEN`, `LIST_ROLE_OVERRIDDEN`, `DUPLICATE_ID_IN_SHADOW_TREE`, `DEFAULT_LANG_INVALID`, `IMAGE_ONLY_CONTROL_CONTENT`, `HEADING_LIKE_NUMBER`, `HEADING_LIKE_LINK`). Core's baselines still match a 1.13 entry to its finding under the new code, and `migrateBaselineEntries()` rewrites a baseline; see core's [`BASELINE.md`](https://github.com/SureA11y/core/blob/main/docs/BASELINE.md#upgrading).

## What changes with `@surea11y/core` 1.12

This release needs `@surea11y/core` 1.12.0. What a scan through this binding shows differently (core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) has the full list):

- **An empty heading now fails an unscoped scan.** `empty-heading` used to ask about a heading with no accessible name; it now fails it. It's a best practice, so it runs in a scan that selects nothing and with `.withBestPractices()`, not under `.withWcag()`, tags or a profile. A gate on a page with `<h2></h2>` that asserted no failures now fails: fix the heading, or scan a WCAG target.
- **Scans that pick rules report their criteria.** `.withRules('img-alt-present')`, a non-WCAG tag or `.withBestPractices()` now fill `rulesResults` with the WCAG criteria those rules belong to, where it was empty. A criterion whose other rules weren't selected is `cantTell` (`reasonCode` `composite.rollup.cantTell.notSelectedChild`), and each check's `rollupIds` names the criteria it was added for. `.wcagLevel()` keeps those criteria to a level.
- **Four rules count towards more criteria**, as W3C's ACT rules map them: `input-image-alt-present` adds 4.1.2, `aria-roles-valid` 1.3.1, `link-name-present` 2.4.9 (AAA), and `meta-refresh-timing-absent` 2.2.4 and 3.2.5 (AAA). The findings don't change; the 1.3.1 and 4.1.2 rollups can now fail where they passed.
- **Unnamed custom elements are questions.** A defined custom element with no visible name may name itself through `ElementInternals`, so it's `cantTell` (`name_internals`) where it used to fail. [`installInternalsHook()`](#web-components-the-internals-hook) lets the engine decide.
- **`engine.wcagLevel`** records the level a scan was gated by, and [`.wcagLevel()`](#usage) sets it.
- **`engine.environment.forcedColors`** records whether the page was in [forced colors](#forced-colors).
- **A custom rule you exclude** isn't a scan gap any more, so `.disableRules()` of one prints no warning.
- **Rule IDs in another case select their rule**: `.withRules('IMG-ALT-PRESENT')` used to throw `INVALID_RUN_ONLY` or be ignored.
- **`runOnly.optInTags` on its own throws** `INVALID_RUN_ONLY`; it was accepted and did nothing. Opt-in rules are unlocked with `.options({ optInRules })`.
- **A finding in a shadow tree is located through its hosts**, as `#card >>> img`, in core's HTML report, SARIF, JUnit and baselines, as `formatFailures()` already did.
- **An inline `policyContract`** with an unknown value in `allowedOutcomes` or `allowedConfidence` drops that value with a warning, where it turned every check into `cantTell`.

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
