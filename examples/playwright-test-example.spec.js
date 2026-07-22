'use strict';

/**
 * Demonstrates the pattern that actually matters for E2E test suites: using
 * A11yCoreBuilder as an accessibility gate inside a real Playwright test
 * (@playwright/test), not just a standalone script -- see basic-scan.js for
 * that simpler case.
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
const { A11yCoreBuilder } = require('../src/index.js');

test('flags real accessibility issues (unlabeled button, missing alt, missing title/lang)', async ({ page }) => {
  await page.goto(
    'data:text/html,<html><body><img src="logo.png"><button></button></body></html>'
  );

  const results = await new A11yCoreBuilder({ page })
    .reportOnly(['fail'])
    .analyze();

  const failedRuleIds = results.checksResults.map((r) => r.ruleId);
  expect(failedRuleIds).toContain('a11ycore-img-alt-present');
  expect(failedRuleIds).toContain('a11ycore-button-name-present');
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
  // fails loudly with which rule(s)/occurrence(s) broke, not just a bare
  // "not equal to []".
  const summary = results.checksResults
    .map((r) => `${r.ruleId} (${r.severity}): ${r.occurrences.length} occurrence(s)`)
    .join('\n');

  expect(results.checksResults, `Accessibility violations found:\n${summary}`).toEqual([]);
});
