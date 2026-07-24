'use strict';

const test = require('node:test');
const assert = require('node:assert');
const playwright = require('playwright');
const { A11yCoreBuilder } = require('../src/index.js');

// A "Playwright binding" implies working across all of Playwright's engines,
// not just Chromium -- every other test in this suite only launches
// chromium.launch(). This proves the injection mechanism itself
// (page.evaluate(wrapperFn, singleArgObject) -- see A11yCoreBuilder.js's own
// header comment) isn't a Chromium-specific accident. Requires
// `npx playwright install firefox webkit` locally -- see README.md.
for (const browserType of ['firefox', 'webkit']) {
  test(`A11yCoreBuilder works against ${browserType}, not just chromium`, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<html><body><img src=x.png><button></button></body></html>');

      const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();
      const ruleIds = results.checksResults.map((r) => r.ruleId);

      assert.ok(ruleIds.includes('img-alt-present'));
      assert.ok(ruleIds.includes('button-name-present'));
    } finally {
      await browser.close();
    }
  });
}
