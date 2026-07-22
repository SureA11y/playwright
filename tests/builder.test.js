'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('../src/index.js');

test('A11yCoreBuilder.analyze() scans a real page and returns a11y-core\'s native result shape', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).analyze();

    assert.ok(Array.isArray(results.checksResults));
    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    assert.ok(fails.some((r) => r.ruleId === 'a11ycore-button-name-present'));
    assert.ok(fails.some((r) => r.ruleId === 'a11ycore-img-alt-present'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: include() scopes the scan to one region', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png" alt=""></section>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).include('#b').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'a11ycore-img-alt-present');
    assert.strictEqual(rule.outcome, 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: include() called twice scans the union of both regions', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png"></section>' +
      '<section id="c"><img src="z.png" alt="decorative"></section>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).include('#a').include('#b').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'a11ycore-img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.strictEqual(rule.occurrences.length, 2); // #a and #b's images, not #c's
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: exclude() skips elements inside the excluded subtree', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div id="excluded"><img src="x.png"></div>' +
      '<div id="included"><img src="y.png" alt=""></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).exclude('#excluded').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'a11ycore-img-alt-present');
    assert.strictEqual(rule.outcome, 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: disableRules() removes a rule from the result entirely', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page })
      .disableRules(['a11ycore-button-name-present'])
      .analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'a11ycore-button-name-present');
    assert.strictEqual(rule, undefined);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withTags() only runs rules carrying at least one of the given tags', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).withTags(['wcag412']).analyze();
    assert.ok(results.checksResults.length > 0);
    // button-name-present carries wcag412 -- should still be present.
    assert.ok(results.checksResults.some((r) => r.ruleId === 'a11ycore-button-name-present'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: options() merges into engineOptions and is actually applied', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).options({ locale: 'fr' }).analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'a11ycore-button-name-present');
    assert.ok(rule, 'button-name-present should be present in the result');
    // Each result echoes back the *resolved* engineOptions it actually ran
    // under (see a11y-core's docs/OUTPUT_SCHEMA.md) -- checking that,
    // rather than just presence, confirms .options() really reached the
    // engine instead of being silently dropped.
    assert.strictEqual(rule.engineOptions.locale, 'fr');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: frames(true) with no sub-frames returns { topFrame, frames: [] }', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

    assert.ok(Array.isArray(results.topFrame.checksResults));
    assert.ok(results.topFrame.checksResults.some((r) => r.ruleId === 'a11ycore-button-name-present' && r.outcome === 'fail'));
    assert.deepStrictEqual(results.frames, []);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: frames(true) scans a sub-frame and keeps its findings separate from the top frame', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // <iframe srcdoc> creates a real, distinct sub-frame with zero network
    // dependency and fully deterministic content -- good for verifying the
    // orchestration logic itself (topFrame vs. frames[], not double-counting).
    await page.goto(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

    // Top frame has no img-alt-present issue (no <img> there at all) and no
    // button-name-present failure (the button has real text).
    const topButtonRule = results.topFrame.checksResults.find((r) => r.ruleId === 'a11ycore-button-name-present');
    assert.strictEqual(topButtonRule.outcome, 'pass');

    assert.strictEqual(results.frames.length, 1);
    const frameImgRule = results.frames[0].checksResults.find((r) => r.ruleId === 'a11ycore-img-alt-present');
    assert.strictEqual(frameImgRule.outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: frames(true) scans a genuinely cross-origin iframe (no a11y-core engine support needed for this -- see ../ROADMAP.md gap #1)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // example.org is IANA-reserved specifically for use in documentation/
    // testing and is about as stable a real external dependency as exists --
    // this is the exact page used to empirically verify the claim in
    // ../ROADMAP.md that cross-origin frame scanning needs no engine work.
    await page.goto('data:text/html,<html><body><iframe src="https://example.org/"></iframe></body></html>');
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

    assert.strictEqual(results.frames.length, 1);
    assert.ok(!results.frames[0].error, `Cross-origin frame scan should not error: ${results.frames[0].error}`);
    assert.ok(Array.isArray(results.frames[0].checksResults));
    assert.ok(results.frames[0].checksResults.length > 0);
  } finally {
    await browser.close();
  }
});
