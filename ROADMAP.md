# a11y-core-playwright Roadmap

Last updated: 2026-07-22 (project created: v1 `A11yCoreBuilder` implemented and verified against real Playwright pages, 7 passing tests. Nothing else built yet.)

Status: living document, same convention as `a11y-core`'s own `ROADMAP.md` — update after every batch of work, so a fresh chat session (or a fresh person) can read this and know exactly what's done, what's next, and *why*, without re-deriving any of it.

---

## 1. What this is and why it's a separate project

`a11y-core` is the DOM-rules accessibility engine, living at `../a11y-core` (a sibling directory, not a parent — this is a separate git repo and a separate npm package). This project is a thin Playwright-specific binding around it: it drives a real browser page, injects the engine, and returns results in a builder API modeled on axe-core's `AxeBuilder` for migration familiarity.

**Why a separate project instead of a monorepo subfolder of `a11y-core`** (decided 2026-07-22): matches how axe-core itself ships (`axe-core` core package + separate `@axe-core/playwright`/`@axe-core/puppeteer` binding packages); keeps `a11y-core` a pure engine dependency with no browser-automation-framework tooling bleeding into its own `package.json`; avoids introducing monorepo tooling (npm workspaces, etc.) into a repo that has none today; allows independent versioning/release cadence once both are published. The one real cost is coordination: since `a11y-core` isn't published, this project depends on it via `"a11y-core": "file:../a11y-core"` in `package.json` — if you move this project, update that path (or once `a11y-core` is published to npm, switch to a real version range and drop the relative dependency entirely).

**Why Playwright first, not Puppeteer/Cypress/WebdriverIO too**: only Playwright's injection mechanics have actually been proven working (`page.evaluate(fn, singleArgObject)`, single-arg only — confirmed empirically against a real Playwright page, see `src/A11yCoreBuilder.js`'s own header comment and `../a11y-core/docs/INTEGRATION.md`). Puppeteer's `page.evaluate` is genuinely variadic (different enough that copying this file wouldn't be a straight port), and Cypress doesn't drive a page via evaluate at all (it runs inside the same browser as the app under test, injection would go through `cy.window()`/a custom command — a different execution model entirely). A generic multi-framework scaffold was considered and deliberately rejected (2026-07-22) as premature abstraction for a need that was just "one Playwright project" — if/when a second framework binding is wanted, treat it as its own new project informed by this one's structure, not a generator invocation.

## 2. Current status (2026-07-22)

**Built and verified**: `src/A11yCoreBuilder.js` — a fluent builder (`include`, `exclude`, `withTags`, `disableTags`, `withRules`, `disableRules`, `options`, `analyze`) wrapping the same single-arg-wrapper injection pattern already proven in `a11y-core`'s own live-DOM cross-engine tooling (`a11y-core/scripts/cross-engine/adapters/a11ycore-live-adapter.js`). 7 tests in `tests/builder.test.js`, all run against real Chromium pages (via `data:` URLs, no network dependency), covering: basic scan, `include()` scoping, `include()` called twice (multi-region union), `exclude()`, `disableRules()`, `withTags()`, and `options()` (verified the option actually reached the engine via the result's own echoed `engineOptions`, not just presence of a result).

**Not yet built**: everything else. This is a working v1 skeleton, not a finished package — no README beyond basic usage, no CI, no npm publish setup, no TypeScript types, no version pinning strategy against `a11y-core` once that's published.

## 3. Known gaps vs. axe-core (prioritized, carried over from `a11y-core`'s own scoping pass)

`a11y-core`'s `ROADMAP.md` §7 item 8 has the full reasoning behind each of these (found 2026-07-22 by reading axe-core's actual `axe.d.ts`, not assumed from memory) — read that for the deeper "why," this is the condensed pointer so it's not lost if this project is ever opened without that context handy.

1. **Cross-frame/iframe scanning** (highest priority, engine-level gap, not fixable in this binding alone). Axe recursively scans same-origin iframes directly and cross-origin ones via a postMessage protocol; `a11y-core` has no general iframe-traversal capability at all today. Real pages put real content in frames (cookie-consent dialogs, payment widgets) — this isn't hypothetical, it's already been hit once this session (BBC News' cookie dialog, see `a11y-core`'s `ROADMAP.md`). Needs to be built in `a11y-core` itself first; this binding would then need to pass `page.frames()` through to whatever new engine capability results.
2. **Element references in results** (`elementRef`-equivalent). Axe can return the actual DOM element alongside the selector string. This binding could add it without any `a11y-core` engine change, by using Playwright's `page.evaluateHandle` instead of `page.evaluate` for an opt-in mode (e.g. `.analyze({ elementRef: true })`) that returns `ElementHandle`s the caller can screenshot/click/highlight directly, instead of re-resolving a selector string (fragile if the DOM shifted). Second priority — pure binding-layer work, no dependency on engine changes.
3. **Result verbosity control** (axe's `reporter: 'no-passes'` equivalent). `a11y-core`'s `checksResults` always includes every rule's outcome, including `pass`/`notApplicable` — a deliberate engine design choice, not something to change there. This binding could add a `.reportOnly(['fail', 'cantTell'])`-style post-filter method for consumers who want a lighter payload for CI at scale. Cheap, binding-layer only.
4. **Runtime custom-rule registration** (axe's `configure({rules, checks})` equivalent). `a11y-core`'s rules are baked in at build time; no runtime plugin model exists. Real architectural gap in the engine, not something this binding can address — out of scope here entirely.
5. **xpath/ancestry addressing.** Axe can report a finding's location as CSS selector, xpath, or a structural-path array. `a11y-core` has an internal `structuralPath` utility (`a11y-core/scripts/cross-engine/structural-path.js`) not yet exposed on public per-occurrence output. Lower priority than the above; would need `a11y-core` to expose it before this binding could surface it.

## 4. Immediate next steps (pick up here)

None of these are started. In roughly the order they'd add the most value for the least cost:

1. **`.reportOnly()` filter** (gap #3 above) — cheapest win, pure binding-layer, no engine dependency.
2. **`elementRef`-style option** (gap #2 above) — moderate effort, `page.evaluateHandle` instead of `page.evaluate`, needs its own test proving a real `ElementHandle` comes back usable (e.g. can be `.click()`ed or screenshotted).
3. Decide on **publishing**: npm org/scope name, whether to wait for `a11y-core` itself to publish first (this package's `file:` dependency needs to become a real version range before anyone else can `npm install` it).
4. **TypeScript types** (`.d.ts`) if the target audience expects them — axe's own `@axe-core/playwright` ships types, worth matching for a fair side-by-side comparison.
5. Cross-frame/iframe support (gap #1) is the highest-value gap but requires new `a11y-core` engine capability first — track it in `a11y-core`'s own `ROADMAP.md` §7 item 8, not here, until that engine work actually starts; then come back and wire this binding up to it.
