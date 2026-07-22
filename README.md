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

## Status and what's next

See `ROADMAP.md` — it documents what's built, what's verified, the known gaps vs. axe-core (prioritized, with reasoning), and exactly what to pick up next. Read it before starting new work here, especially in a fresh chat session that hasn't seen how this project came to exist.
