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
