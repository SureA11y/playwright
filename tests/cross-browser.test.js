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

// What @surea11y/core 1.12 asks of the driver: emulated forced colors are
// recorded, and the internals hook reads a name a component keeps in a
// private ElementInternals.
for (const browserType of ['firefox', 'webkit']) {
  test(`A11yCoreBuilder records emulated forced colors in ${browserType}`, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage();
      await page.emulateMedia({ forcedColors: 'active' });
      await page.goto('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>');
      const results = await new A11yCoreBuilder({ page }).withRules('contrast-minimum').analyze();
      assert.strictEqual(results.engine.environment.forcedColors, 'active');
    } finally {
      await browser.close();
    }
  });

  test(`A11yCoreBuilder.installInternalsHook() works in ${browserType}`, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage();
      await A11yCoreBuilder.installInternalsHook(page);
      await page.goto('data:text/html,' + encodeURIComponent(
        '<!doctype html><html lang="en"><head><title>t</title><script>' +
        "customElements.define('x-check', class extends HTMLElement { #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.ariaLabel = 'Subscribe'; this.#i.ariaChecked = 'false'; } });" +
        '</script></head><body><main><h1>Hi</h1><x-check role="checkbox"></x-check></main></body></html>'
      ));
      const results = await new A11yCoreBuilder({ page }).withRules('binary-control-name-present').analyze();
      assert.strictEqual(results.engine.environment.internalsHook, 'early');
      assert.strictEqual(results.checksResults[0].outcome, 'pass');
    } finally {
      await browser.close();
    }
  });
}
