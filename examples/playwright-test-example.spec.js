'use strict';

/**
 * Demonstrates the pattern that actually matters for E2E test suites: using
 * A11yCoreBuilder as an accessibility gate inside a real Playwright test
 * (@playwright/test), not just a standalone script -- see basic-scan.js for
 * that simpler case, and scan-with-pack.js for a scan against a pack.
 *
 * This project depends on the "playwright" package rather than
 * "@playwright/test" directly, so this imports the test runner via
 * "playwright/test" (a re-export Microsoft ships for exactly this case --
 * see ../node_modules/playwright/test.js). A real project usually installs
 * "@playwright/test" itself and would `require('@playwright/test')`
 * instead; the two are interchangeable, same test()/expect().
 *
 * Run: npx playwright test examples/playwright-test-example.spec.js
 */

const { test, expect } = require('playwright/test');
const { A11yCoreBuilder, formatFailures, getScanGaps } = require('../src/index.js');

test('flags real accessibility issues (unlabeled button, missing alt, missing title/lang)', async ({ page }) => {
  await page.goto(
    'data:text/html,<html><body><img src="logo.png"><button></button></body></html>'
  );

  const results = await new A11yCoreBuilder({ page })
    .reportOnly(['fail'])
    .analyze();

  const failedRuleIds = results.checksResults.map((r) => r.ruleId);
  expect(failedRuleIds).toContain('img-alt-present');
  expect(failedRuleIds).toContain('button-name-present');
});

test('a well-formed page has no accessibility violations', async ({ page }) => {
  await page.goto(
    'data:text/html,<html lang="en"><head><title>Example</title></head>' +
    '<body><main><h1>Hello</h1><button>Click me</button></main></body></html>'
  );

  const results = await new A11yCoreBuilder({ page })
    .reportOnly(['fail'])
    .analyze();

  // The real assertion shape you'd use as an accessibility gate in CI --
  // formatFailures() turns the result into a readable block (rule,
  // severity, selector, hint per occurrence, then anything the scan left
  // out and the engine version) instead of a bare "not equal to []" diff,
  // so a failure is scannable straight from CI/terminal output.
  expect(results.checksResults, formatFailures(results)).toEqual([]);
  // A scan that left something out (an include() that matched nothing, a
  // custom rule that didn't run) has no failures either; fail on it too.
  expect(getScanGaps(results), formatFailures(results)).toEqual([]);
});

test("a page meets a pack's checklist (here, acme-policy-pack.js)", async ({ page }) => {
  const acmePolicy = require('./acme-policy-pack.js');
  await page.goto(
    'data:text/html,<html lang="en"><head><title>Example</title></head>' +
    '<body><main><h1>Hello</h1><img src="logo.png" alt="Acme"><video src="intro.mp4" autoplay muted></video></main></body></html>'
  );

  const results = await new A11yCoreBuilder({ page })
    .withPacks(acmePolicy)
    .options({ profile: 'acme-web-2026' })
    .reportOnly(['fail'])
    .analyze();

  expect(results.checksResults, formatFailures(results)).toEqual([]);
  // A pack that didn't run (its core range, or a page on another core)
  // would otherwise pass here with nothing checked.
  expect(getScanGaps(results), formatFailures(results)).toEqual([]);
});
