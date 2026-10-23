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

  test(`A11yCoreBuilder.installListenerHook() works in ${browserType}`, { skip: typeof require('@surea11y/core').listenerHookScript !== 'function' && 'needs @surea11y/core 1.14.0' }, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage();
      await A11yCoreBuilder.installListenerHook(page);
      await page.goto('data:text/html,' + encodeURIComponent(
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
        '<div id="save" role="button" tabindex="0">Save</div>' +
        "<script>document.getElementById('save').addEventListener('click', () => {});</script>" +
        '</main></body></html>'
      ));
      const results = await new A11yCoreBuilder({ page }).withRules('click-handler-keyboard-operable').analyze();
      assert.strictEqual(results.engine.environment.listenerHook, 'early');
      assert.strictEqual(results.checksResults[0].outcome, 'fail');
    } finally {
      await browser.close();
    }
  });

  test(`A11yCoreBuilder.installLiveRegionHook() and getAnnouncements() work in ${browserType}`, { skip: !(typeof require('@surea11y/core').liveRegionHookScript === 'function' && typeof require('@surea11y/binding-base').createInPageAnnouncements === 'function') && 'needs @surea11y/core 1.14.0 and @surea11y/binding-base 1.6.0' }, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage();
      await A11yCoreBuilder.installLiveRegionHook(page);
      await page.goto('data:text/html,' + encodeURIComponent(
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
        '<div id="status" role="status"></div><div id="h" role="status" hidden></div></main></body></html>'
      ));
      await page.evaluate(() => { document.getElementById('status').textContent = 'Saved'; });
      await page.evaluate(() => { const h = document.getElementById('h'); h.hidden = false; h.textContent = 'Together'; });
      const said = await A11yCoreBuilder.getAnnouncements(page);
      assert.deepStrictEqual(said.map((a) => a.text), ['Saved']);
      const results = await new A11yCoreBuilder({ page }).withRules('live-region-announcements').analyze();
      assert.strictEqual(results.engine.environment.liveRegionHook, 'early');
      assert.deepStrictEqual(
        results.checksResults[0].occurrences.map((o) => o.data.details.reasonCode),
        ['LIVE_REGION_SHOWN_AND_FILLED']
      );
    } finally {
      await browser.close();
    }
  });

  // .conditions() sets the color scheme with page.emulateMedia() and the width
  // with page.setViewportSize(), which every Playwright engine supports.
  test(`A11yCoreBuilder.conditions() scans dark mode and a phone width in ${browserType}`, { skip: typeof require('@surea11y/binding-base').mergeConditionResults !== 'function' && 'needs @surea11y/binding-base 1.6.0' }, async () => {
    const browser = await playwright[browserType].launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
      // Reads well in the light scheme; in the dark one its text is #444 on #222.
      await page.goto('data:text/html,' + encodeURIComponent(
        '<!doctype html><html lang="en"><head><title>t</title><style>' +
        'body { color: #111; background: #fff } ' +
        '@media (prefers-color-scheme: dark) { body { color: #444; background: #222 } }' +
        '</style></head><body><main><h1>Hi</h1><p>Read me</p></main></body></html>'
      ));
      const results = await new A11yCoreBuilder({ page })
        .withRules('contrast-minimum')
        .conditions([{ colorScheme: 'dark' }, { width: 320 }])
        .analyze();
      assert.deepStrictEqual(
        results.conditionRuns.map((r) => [r.condition, r.environment.viewport.width, r.environment.colorScheme]),
        [['default', 1024, 'light'], ['dark', 1024, 'dark'], ['width 320', 320, 'light']]
      );
      const check = results.checksResults.find((r) => r.ruleId === 'contrast-minimum');
      assert.strictEqual(check.outcome, 'fail');
      for (const o of check.occurrences) assert.deepStrictEqual(o.conditions, ['dark']);
      assert.deepStrictEqual(page.viewportSize(), { width: 1024, height: 700 });
      assert.strictEqual(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), false);
    } finally {
      await browser.close();
    }
  });
}
