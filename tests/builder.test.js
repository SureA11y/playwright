'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { A11yCoreBuilder, EngineError, getScanGaps, formatFailures } = require('../src/index.js');

// Shared across the customRules tests below -- reported outcome depends on
// whether ctx.document has a .my-widget element. runInPage must be a
// function-source STRING, not a live function -- engineOptions crosses a
// page.evaluate() JSON boundary that can't carry a live Function reference.
const MY_ORG_CUSTOM_RULE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage: (function (ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }).toString()
};

// Same rule, but as a real, LIVE function -- used to prove
// .withCustomRules() converts it to a source string itself, unlike the raw
// .options({ customRules }) passthrough above, which requires the caller to
// call .toString() themselves.
const MY_ORG_CUSTOM_RULE_LIVE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// A second, distinct rule ID -- used to prove withCustomRules() can register
// more than one rule at once (array form) and accumulates across calls.
const SECOND_CUSTOM_RULE = {
  id: 'my-org-second-custom-rule',
  meta: { title: 'My second custom rule', tags: ['custom'] },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-other-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// Exercises the optional `applicability` field -- also accepted as a live
// function and converted the same way as runInPage. When applicability
// returns false, surea11y reports 'notApplicable' WITHOUT ever invoking
// runInPage; runInPage here always reports 'pass' so the two outcomes are
// unambiguous proof of which path ran.
const CUSTOM_RULE_WITH_APPLICABILITY = {
  id: 'my-org-conditional-custom-rule',
  meta: { title: 'Conditional custom rule', tags: ['custom'] },
  applicability(ctx) {
    return !!ctx.document.querySelector('.applicability-gate');
  },
  runInPage() {
    return { outcome: 'pass', occurrences: [] };
  }
};

test('A11yCoreBuilder.analyze() scans a real page and returns surea11y\'s native result shape', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).analyze();

    assert.ok(Array.isArray(results.checksResults));
    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    assert.ok(fails.some((r) => r.ruleId === 'button-name-present'));
    assert.ok(fails.some((r) => r.ruleId === 'img-alt-present'));
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
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
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
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.strictEqual(rule.occurrences.length, 2); // #a and #b's images, not #c's
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: scoping methods (include/exclude/withRules/etc.) accumulate across analyze() calls on the same instance -- create one builder per scan', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<section id="a"><img src="x.png"></section>' +
      '<section id="b"><img src="y.png"></section>' +
      '</body></html>'
    );

    // The builder is a mutable object with no reset between analyze() calls
    // -- include()/exclude()/withRules()/disableRules()/withTags()/
    // disableTags()/options() all push onto or merge into internal arrays/
    // objects that persist for the instance's lifetime. This is intentional
    // for "call include() multiple times within ONE scan" (see the test
    // above), but the same accumulation applies across separate analyze()
    // calls if you reuse an instance -- documented here so it's a known,
    // tested behavior rather than a silent surprise for anyone holding a
    // builder across multiple assertions. See README.md's own note.
    const builder = new A11yCoreBuilder({ page });
    const first = await builder.include('#a').analyze();
    const second = await builder.include('#b').analyze(); // scope is now #a AND #b, not just #b

    const firstRule = first.checksResults.find((r) => r.ruleId === 'img-alt-present');
    const secondRule = second.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.deepStrictEqual(firstRule.occurrences.map((o) => o.selector), ['#a > img']);
    assert.deepStrictEqual(secondRule.occurrences.map((o) => o.selector), ['#a > img', '#b > img']);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: reportOnly()/frames()/elementRef() overwrite on repeated calls, unlike the accumulating scoping methods above', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const builder = new A11yCoreBuilder({ page }).reportOnly(['fail']);
    await builder.analyze();
    // Calling reportOnly() again REPLACES the previous outcomes list rather
    // than merging with it -- unlike include()/withRules()/etc. above.
    const results = await builder.reportOnly(['pass']).analyze();

    assert.ok(results.checksResults.length > 0);
    assert.ok(results.checksResults.every((r) => r.outcome === 'pass'));
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
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: include() and exclude() combined -- scoped to a region, minus a sub-part of it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<section id="scope"><div id="excluded"><img src="x.png"></div><img src="y.png"></section>' +
      '<img src="z.png">' + // outside #scope entirely -- must not count either
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).include('#scope').exclude('#excluded').analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.deepStrictEqual(rule.occurrences.map((o) => o.selector), ['#scope > img']);
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
      .disableRules(['button-name-present'])
      .analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.strictEqual(rule, undefined);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withRules() only runs the given rule IDs', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page })
      .withRules(['img-alt-present'])
      .analyze();

    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['img-alt-present']);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withRules() and disableRules() combined on the same rule ID -- disableRules wins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    // surea11y applies excludeRuleIds *after* includeRuleIds (see
    // ../surea11y/docs/ENGINE_OPTIONS.md) -- disableRules() should win over
    // withRules() when the same ID appears in both.
    const results = await new A11yCoreBuilder({ page })
      .withRules(['img-alt-present', 'button-name-present'])
      .disableRules(['img-alt-present'])
      .analyze();

    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['button-name-present']);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: disableTags() never runs rules carrying any of the given tags', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    // button-name-present carries wcag412 -- disabling that tag should remove it.
    const results = await new A11yCoreBuilder({ page }).disableTags(['wcag412']).analyze();
    assert.ok(!results.checksResults.some((r) => r.ruleId === 'button-name-present'));
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
    assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withTags() and disableTags() combined on the same tag -- disableTags wins, leaving nothing', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).withTags(['wcag412']).disableTags(['wcag412']).analyze();
    assert.deepStrictEqual(results.checksResults, []);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withRules() and withTags() combined require BOTH to match (surea11y\'s default "and" includeMode)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    // surea11y's default includeMode is 'and' when both an ID include and a
    // tag include are given (see ../surea11y/docs/ENGINE_OPTIONS.md) -- this
    // binding doesn't expose includeMode, so combining withRules() and
    // withTags() is stricter than either alone, not an OR of the two. Worth
    // locking down since it's non-obvious: img-alt-present doesn't carry
    // wcag412, so this combination yields nothing even though img-alt-present
    // alone matches withRules() and button-name-present alone matches wcag412.
    const results = await new A11yCoreBuilder({ page })
      .withRules(['img-alt-present'])
      .withTags(['wcag412'])
      .analyze();

    assert.deepStrictEqual(results.checksResults, []);
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
    const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.ok(rule, 'button-name-present should be present in the result');
    // Each result echoes back the *resolved* engineOptions it actually ran
    // under (see surea11y's docs/OUTPUT_SCHEMA.md) -- checking that,
    // rather than just presence, confirms .options() really reached the
    // engine instead of being silently dropped.
    assert.strictEqual(rule.engineOptions.locale, 'fr');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: options({ customRules }) registers a runtime custom rule via surea11y\'s engineOptions passthrough', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    // No dedicated builder method for this yet --
    // .options() already forwards arbitrary engineOptions, including
    // surea11y's customRules runtime-registration escape hatch (see
    // ../surea11y/docs/ENGINE_OPTIONS.md).
    const results = await new A11yCoreBuilder({ page })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .analyze();

    const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
    assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
    assert.strictEqual(custom.outcome, 'fail');
    // Confirms the custom rule's occurrence gets the same automatic
    // selector/structuralPath fill-in a built-in rule's does, not a raw
    // pass-through of whatever the custom runInPage returned.
    assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
    assert.deepStrictEqual(custom.occurrences[0].structuralPath, [1, 0]);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: options({ customRules }) combined with frames(true) -- the custom rule runs in every frame, not just the top one', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page })
      .frames(true)
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .analyze();

    assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: options({ customRules }) combined with reportOnly() -- the custom rule is filtered the same as a built-in one', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ page })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .reportOnly(['fail'])
      .analyze();

    assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() registers a runtime custom rule, converting a live runInPage function to a source string automatically', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    // MY_ORG_CUSTOM_RULE_LIVE's runInPage is a real, live function -- unlike
    // the raw .options({ customRules }) passthrough above, which requires a
    // pre-stringified function, withCustomRules() must convert it itself.
    const results = await new A11yCoreBuilder({ page })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .analyze();

    const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
    assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
    assert.strictEqual(custom.outcome, 'fail');
    assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() accepts an array to register multiple rules in one call', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page })
      .withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, SECOND_CUSTOM_RULE])
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() accumulates across repeated calls, like withRules()/withTags()', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .withCustomRules(SECOND_CUSTOM_RULE) // adds a second rule, doesn't replace the first
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() composes with a raw options({ customRules }) call rather than clobbering it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<div class="my-other-widget"></div>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page })
      .options({ customRules: [MY_ORG_CUSTOM_RULE] })
      .withCustomRules(SECOND_CUSTOM_RULE)
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() runs the rule in every frame when combined with frames(true)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page })
      .frames(true)
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .analyze();

    assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
    assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() is filtered the same as a built-in rule when combined with reportOnly()', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ page })
      .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
      .reportOnly(['fail'])
      .analyze();

    assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() converts a live applicability function too, and respects its true/false result', async () => {
  const browser = await chromium.launch();
  try {
    const browserPage1 = await browser.newPage();
    await browserPage1.goto('data:text/html,<html><body><div class="applicability-gate"></div></body></html>');
    const applicableResults = await new A11yCoreBuilder({ page: browserPage1 })
      .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
      .analyze();
    assert.strictEqual(
      applicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
      'pass'
    );
    await browserPage1.close();

    const browserPage2 = await browser.newPage();
    await browserPage2.goto('data:text/html,<html><body></body></html>');
    const notApplicableResults = await new A11yCoreBuilder({ page: browserPage2 })
      .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
      .analyze();
    assert.strictEqual(
      notApplicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
      'notApplicable'
    );
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() still accepts an already-stringified runInPage, same as the raw options() passthrough', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    const results = await new A11yCoreBuilder({ page })
      .withCustomRules(MY_ORG_CUSTOM_RULE) // runInPage is already a string here
      .analyze();

    assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withCustomRules() throws synchronously on a missing/empty id, instead of failing silently deep in the page', () => {
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({ runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({ id: '', runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when runInPage is missing or not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({ id: 'no-run-fn' }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({ id: 'bad-run-fn', runInPage: 123 }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({ id: 'empty-run-fn', runInPage: '' }),
    /requires a `runInPage` function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when applicability is provided but not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ page: { evaluate: () => {} } }).withCustomRules({
      id: 'bad-applicability',
      runInPage: () => ({}),
      applicability: 123
    }),
    /`applicability` must be a function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() rejects the whole call (no partial registration) when one descriptor in an array is invalid', () => {
  const builder = new A11yCoreBuilder({ page: { evaluate: () => {} } });
  assert.throws(
    () => builder.withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, { id: '', runInPage: () => ({}) }]),
    /requires a non-empty string `id`/
  );
  // Confirms the valid entry earlier in the array wasn't partially pushed
  // onto internal state before the invalid one threw.
  assert.strictEqual(builder._customRules.length, 0);
});

test('A11yCoreBuilder: frames(true) with no sub-frames returns { topFrame, frames: [] }', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

    assert.ok(Array.isArray(results.topFrame.checksResults));
    assert.ok(results.topFrame.checksResults.some((r) => r.ruleId === 'button-name-present' && r.outcome === 'fail'));
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
    const topButtonRule = results.topFrame.checksResults.find((r) => r.ruleId === 'button-name-present');
    assert.strictEqual(topButtonRule.outcome, 'pass');

    assert.strictEqual(results.frames.length, 1);
    const frameImgRule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(frameImgRule.outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: reportOnly() filters checksResults down to the given outcomes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();

    assert.ok(results.checksResults.length > 0);
    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: reportOnly() rejects an invalid outcome value', async () => {
  const page = { evaluate: async () => {} };
  assert.throws(
    () => new A11yCoreBuilder({ page }).reportOnly(['nope']),
    /invalid outcome "nope"/
  );
});

test('A11yCoreBuilder: reportOnly() applies per-frame when combined with frames(true)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page }).frames(true).reportOnly(['fail']).analyze();

    assert.ok(results.topFrame.checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.frames[0].checksResults.every((r) => r.outcome === 'fail'));
    assert.ok(results.frames[0].checksResults.some((r) => r.ruleId === 'img-alt-present'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: elementRef(true) attaches a live, usable ElementHandle to each fail/cantTell occurrence', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img id="pic" src="x.png"></body></html>');

    const results = await new A11yCoreBuilder({ page }).elementRef(true).analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    const [occurrence] = rule.occurrences;
    assert.ok(occurrence.elementHandle, 'occurrence should carry a live ElementHandle');
    // Prove it's a real, usable handle into the page -- not just a
    // truthy placeholder -- by reading a live DOM property through it.
    const id = await occurrence.elementHandle.evaluate((el) => el.id);
    assert.strictEqual(id, 'pic');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: reportOnly() and elementRef(true) combined -- surviving occurrences still carry a usable ElementHandle', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img id="pic" src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).elementRef(true).analyze();

    assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    const id = await rule.occurrences[0].elementHandle.evaluate((el) => el.id);
    assert.strictEqual(id, 'pic');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: elementRef(true) leaves elementHandle null for an occurrence with no resolvable selector, instead of throwing', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button>x</button></body></html>');

    // contrast-enhanced can report a page-wide occurrence with
    // selector: "" (no single target element) -- confirms .elementRef(true)
    // doesn't crash calling .$("") on it (an invalid CSS selector) and
    // instead leaves elementHandle null.
    const results = await new A11yCoreBuilder({ page }).elementRef(true).analyze();
    const rule = results.checksResults.find((r) => r.ruleId === 'contrast-enhanced');
    const occurrence = rule.occurrences.find((o) => o.selector === '');
    assert.ok(occurrence, 'expected an occurrence with an empty selector on this page');
    assert.strictEqual(occurrence.elementHandle, null);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: elementRef(true) resolves against each frame\'s own document when combined with frames(true)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<button>Top button, has a name</button>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg id=inner src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page }).frames(true).elementRef(true).analyze();

    const rule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    const id = await rule.occurrences[0].elementHandle.evaluate((el) => el.id);
    assert.strictEqual(id, 'inner');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: frames(true) scans a genuinely cross-origin iframe (no surea11y engine support needed for this)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // example.org is IANA-reserved specifically for use in documentation/
    // testing and is about as stable a real external dependency as exists --
    // this is the exact page used to empirically verify that cross-origin
    // frame scanning needs no engine work.
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

test('A11yCoreBuilder: withRules() naming no known rule rejects with an EngineError carrying INVALID_RUN_ONLY', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"></body></html>');

    // A typo used to select nothing and pass the scan; since @surea11y/core
    // 1.10.0 the engine throws, and the code survives page.evaluate().
    await assert.rejects(
      () => new A11yCoreBuilder({ page }).withRules(['img-alt-presnt']).analyze(),
      (err) => {
        assert.ok(err instanceof EngineError);
        assert.strictEqual(err.name, 'EngineError');
        assert.strictEqual(err.code, 'INVALID_RUN_ONLY');
        assert.strictEqual(err.selector, null);
        return true;
      }
    );
    await assert.rejects(
      () => new A11yCoreBuilder({ page }).withTags(['wcag2.2aa']).analyze(),
      (err) => err instanceof EngineError && err.code === 'INVALID_RUN_ONLY'
    );
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: an include() selector the browser cannot parse rejects with INVALID_CONTEXT_SELECTOR and the selector', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><main><img src="x.png"></main></body></html>');

    await assert.rejects(
      () => new A11yCoreBuilder({ page }).include('main').include('#[broken').analyze(),
      (err) => {
        assert.ok(err instanceof EngineError);
        assert.strictEqual(err.code, 'INVALID_CONTEXT_SELECTOR');
        assert.strictEqual(err.selector, '#[broken');
        return true;
      }
    );
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: an engine error from the top frame rejects a frames(true) scan rather than being recorded as a frame error', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    await assert.rejects(
      () => new A11yCoreBuilder({ page }).frames(true).withRules(['no-such-rule']).analyze(),
      (err) => err instanceof EngineError && err.code === 'INVALID_RUN_ONLY'
    );
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withTags()/withRules()/disableTags()/disableRules() throw at the call for undefined or an empty string', () => {
  const page = { evaluate: async () => {} };
  for (const method of ['withTags', 'withRules', 'disableTags', 'disableRules']) {
    for (const value of [undefined, '', [undefined], ['']]) {
      assert.throws(
        () => new A11yCoreBuilder({ page })[method](value),
        (err) => err instanceof TypeError && err.code === 'INVALID_RUN_ONLY',
        `${method}(${JSON.stringify(value)})`
      );
    }
  }
});

test('A11yCoreBuilder: include() with frames(true) scopes the top frame only -- each sub-frame is scanned whole', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // The sub-frame has no #main. Since @surea11y/core 1.10.0 a selector
    // matching nothing scans nothing, so handing the top frame's selector to
    // the sub-frame would hide its missing alt.
    await page.goto(
      'data:text/html,<html><body>' +
      '<main id="main"><img src="a.png" alt="A"></main><img src="outside.png">' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = await new A11yCoreBuilder({ page }).include('#main').frames(true).analyze();

    assert.strictEqual(results.topFrame.contextSelector, '#main');
    assert.deepStrictEqual(results.topFrame.contextMatch, { elementCount: 1, unmatchedSelectors: [] });
    const topImg = results.topFrame.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(topImg.outcome, 'pass'); // the image outside #main is out of scope

    assert.strictEqual(results.frames.length, 1);
    assert.strictEqual(results.frames[0].contextSelector, null);
    assert.strictEqual(results.frames[0].contextMatch, null);
    const frameImg = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(frameImg.outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: elementRef(true) resolves a shadow-DOM occurrence through its shadow hosts', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<html><body>' +
      '<img src="light.png" alt="Light DOM image">' +
      '<my-card id="card"></my-card>' +
      '<script>' +
      'document.getElementById("card").attachShadow({ mode: "open" }).innerHTML = \'<p>Card</p><img src="shadow.png">\';' +
      '</script>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).withRules(['img-alt-present']).elementRef(true).analyze();

    const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(rule.outcome, 'fail');
    assert.strictEqual(rule.occurrences.length, 1);
    const [occurrence] = rule.occurrences;
    // The selector holds inside the shadow root only; the host leads there.
    // Looked up in the document (even with Playwright's shadow-piercing
    // page.$()), it doesn't find the shadow image: core 1.14 gives an
    // element at the top of a shadow root a selector that matches no
    // light-DOM element, where 1.13 found the light-DOM image.
    assert.deepStrictEqual(occurrence.shadowHostSelectors, ['#card']);
    const viaDocument = await page.$(occurrence.selector);
    const foundViaDocument = viaDocument && await viaDocument.evaluate((el) => el.getAttribute('src'));
    assert.notStrictEqual(foundViaDocument, 'shadow.png');

    assert.ok(occurrence.elementHandle, 'occurrence should carry a live ElementHandle');
    assert.strictEqual(await occurrence.elementHandle.evaluate((el) => el.getAttribute('src')), 'shadow.png');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: elementRef(true) leaves elementHandle null when a shadow host is gone by the time it resolves', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><img src="x.png"></body></html>');

    const builder = new A11yCoreBuilder({ page });
    const result = await builder._attachElementRefs(page, {
      checksResults: [{ occurrences: [{ selector: 'img', shadowHostSelectors: ['#no-such-host'] }] }]
    });
    assert.strictEqual(result.checksResults[0].occurrences[0].elementHandle, null);
  } finally {
    await browser.close();
  }
});

// Captures console.warn for the length of fn(), so the gap warnings below
// can be checked (and don't clutter the test output).
async function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('A11yCoreBuilder: analyze() warns when the include() scope matched nothing, and stays quiet on a clean scan', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"></body></html>');

    const warnings = await captureWarnings(() => new A11yCoreBuilder({ page }).include('#mian').analyze());
    assert.strictEqual(warnings.length, 1, warnings.join('\n'));
    assert.ok(warnings[0].startsWith('@surea11y/playwright (data:text/html,'), warnings[0]);
    assert.ok(warnings[0].includes('Nothing was scanned: the scan scope matched no element ("#mian").'), warnings[0]);

    const none = await captureWarnings(() => new A11yCoreBuilder({ page }).analyze());
    assert.deepStrictEqual(none, []);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: analyze() warns once per scanned frame about a custom rule that did not run', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cp%3EHi%3C/p%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const warnings = await captureWarnings(() => new A11yCoreBuilder({ page })
      .options({ customRules: [{ id: 'never-runs', meta: { title: 'Never runs' }, runInPage: 'not a function' }] })
      .frames(true)
      .analyze());
    assert.strictEqual(warnings.length, 2, warnings.join('\n'));
    for (const w of warnings) assert.ok(w.includes('Custom rule "never-runs" did not run'), w);
    assert.ok(warnings[1].includes('(about:srcdoc)'), warnings[1]);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: logger() receives each scan gap with its frame\'s result, instead of console.warn', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cp%3Einner%3C/p%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});

    const seen = [];
    const warnings = await captureWarnings(() => new A11yCoreBuilder({ page })
      .include('#missing')
      .options({ customRules: [{ id: 'never-runs', meta: { title: 'Never runs' }, runInPage: 'not a function' }] })
      .frames(true)
      .logger((gap, frame) => seen.push([gap.kind, frame.url]))
      .analyze());
    assert.deepStrictEqual(warnings, []);
    // The scope matched nothing in the top frame; the custom rule was
    // skipped there and in the sub-frame. Each gap comes with its frame.
    assert.deepStrictEqual(seen.map(([kind]) => kind).sort(), ['context-not-found', 'custom-rule-skipped', 'custom-rule-skipped']);
    assert.strictEqual(seen.filter(([, url]) => url === 'about:srcdoc').length, 1, JSON.stringify(seen));
  } finally {
    await browser.close();
  }
});

// A pack (@surea11y/core/pack, plain object form): a rule, a 7:1 variant of
// contrast-minimum, and a checklist profile with one item.
const ACME_PACK = {
  name: '@acme/a11y-rules',
  version: '1.0.0',
  namespace: 'acme',
  core: '*',
  title: 'Acme policy',
  rules: [
    {
      id: 'acme-no-widget',
      meta: { title: 'No widget', tags: ['house-rules'] },
      runInPage(ctx) {
        const el = ctx.document.querySelector('.my-widget');
        return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'pass' };
      }
    }
  ],
  variants: [
    {
      id: 'acme-contrast-enhanced',
      from: 'contrast-minimum',
      config: { normalTextRatio: 7, largeTextRatio: 4.5 },
      meta: {
        title: 'Text contrast is at least 7:1',
        tags: ['house-rules'],
        i18n: { titleKey: 'acmeContrastEnhanced_title', descriptionKey: 'acmeContrastEnhanced_description' }
      }
    }
  ],
  dictionaries: {
    en: {
      acmeContrastEnhanced_title: 'Text contrast is at least 7:1',
      acmeContrastEnhanced_description: 'Checks text contrast at 7:1.'
    }
  },
  profiles: { 'acme-1': { tags: ['wcag2a', 'wcag2aa', 'house-rules'] } },
  rollups: [{ id: 'acme-text', title: 'Text', checksIds: ['contrast-minimum', 'acme-contrast-enhanced'] }]
};

test('A11yCoreBuilder: withPacks() runs a pack in the page, its profile and variant included', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html lang="en"><head><title>t</title></head><body><main>' +
      '<div class="my-widget">W</div><p style="color:%23767676;background:%23fff">Grey</p></main></body></html>'
    );
    const result = await new A11yCoreBuilder({ page })
      .withPacks(ACME_PACK)
      .options({ profile: 'acme-1' })
      .analyze();
    assert.deepStrictEqual(result.engine.packs, ['@acme/a11y-rules@1.0.0']);
    assert.strictEqual(result.engine.profile, 'acme-1');
    const outcome = (id) => result.checksResults.find((r) => r.ruleId === id).outcome;
    assert.strictEqual(outcome('acme-no-widget'), 'fail');
    // #767676 on white is 4.54:1: core's rule passes, the 7:1 variant fails.
    assert.strictEqual(outcome('contrast-minimum'), 'pass');
    assert.strictEqual(outcome('acme-contrast-enhanced'), 'fail');
    assert.strictEqual(result.rulesResults.find((r) => r.ruleId === 'acme-text').outcome, 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withPacks() runs the pack in every frame when combined with frames(true)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<html><body>' +
      '<div class="my-widget"></div>' +
      '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
      '</body></html>'
    );
    await page.waitForLoadState('networkidle').catch(() => {});
    const results = await new A11yCoreBuilder({ page }).frames(true).withPacks(ACME_PACK).analyze();
    for (const r of [results.topFrame, results.frames[0]]) {
      assert.deepStrictEqual(r.engine.packs, ['@acme/a11y-rules@1.0.0']);
      assert.strictEqual(r.checksResults.find((c) => c.ruleId === 'acme-no-widget').outcome, 'fail');
    }
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withPacks() can scan the same page twice', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="en"><head><title>t</title></head><body><div class="my-widget">W</div></body></html>');
    for (let i = 0; i < 2; i++) {
      const result = await new A11yCoreBuilder({ page }).withPacks(ACME_PACK).withRules('acme-no-widget').analyze();
      assert.deepStrictEqual(result.checksResults.map((r) => [r.ruleId, r.outcome]), [['acme-no-widget', 'fail']]);
    }
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: a pack the page does not run is a pack-skipped gap, and analyze() warns about it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>');
    let result;
    const warnings = await captureWarnings(async () => {
      result = await new A11yCoreBuilder({ page }).options({ packs: ['@acme/not-registered@1.0.0'] }).withRules('img-alt-present').analyze();
    });
    const gaps = getScanGaps(result);
    assert.deepStrictEqual(gaps.map((g) => [g.kind, g.pack.name]), [['pack-skipped', '@acme/not-registered@1.0.0']]);
    assert.ok(warnings.some((w) => w.includes('Pack "@acme/not-registered@1.0.0" did not run')), warnings.join('\n'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: withWcag() runs a WCAG target, and withBestPractices() adds the best practices', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>');
    const target = await new A11yCoreBuilder({ page }).withWcag('2.2', 'AA').analyze();
    const ids = target.checksResults.map((r) => r.ruleId);
    assert.strictEqual(target.engine.wcagVersion, '2.2');
    assert.ok(ids.includes('img-alt-present'));
    assert.ok(!ids.includes('duplicate-id'), '4.1.1 is no part of a WCAG 2.2 target');
    assert.ok(!ids.includes('region'));
    const withBest = await new A11yCoreBuilder({ page }).withWcag('2.2', 'AA').withBestPractices().analyze();
    assert.ok(withBest.checksResults.some((r) => r.ruleId === 'region'));
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: strictOptions rejects a misspelt option with an EngineError carrying INVALID_ENGINE_OPTIONS', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="en"><head><title>t</title></head><body></body></html>');
    await assert.rejects(
      () => new A11yCoreBuilder({ page }).options({ strictOptions: true, lcoale: 'fr' }).analyze(),
      (err) => err instanceof EngineError && err.code === 'INVALID_ENGINE_OPTIONS' && /lcoale/.test(err.message)
    );
  } finally {
    await browser.close();
  }
});

test("A11yCoreBuilder: a frames(true) result goes to @surea11y/core's SARIF report with every frame's findings", async () => {
  const { renderSarifReport } = require('@surea11y/core/sarif');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<html lang="en"><head><title>t</title></head><body><img src="top.png">' +
      '<iframe title="Ad" srcdoc="<html lang=en><head><title>f</title></head><body><img src=ad.png></body></html>"></iframe></body></html>'
    );
    await page.waitForLoadState('load');
    const results = await new A11yCoreBuilder({ page }).frames(true).withRules('img-alt-present').analyze();
    const run = JSON.parse(renderSarifReport(results)).runs[0];
    const failures = run.results.filter((r) => r.ruleId === 'img-alt-present' && r.level === 'error');
    assert.strictEqual(failures.length, 2, JSON.stringify(failures.map((r) => r.locations)));
    const notices = (run.invocations || []).flatMap((i) => i.toolExecutionNotifications || []);
    assert.deepStrictEqual(notices.map((n) => n.message.text), [], 'no frame reported as not scanned');
  } finally {
    await browser.close();
  }
});

// --- @surea11y/core 1.12 -------------------------------------------------------------

// Web components that keep their ElementInternals in a private field, where
// no script but the internals hook can read them: one names itself and sets
// its state, one is a switch only through its internals, with no name, and
// one is the same switch named through its internals.
const COMPONENTS_SCRIPT = `<script>
customElements.define('x-check', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.ariaLabel = 'Subscribe'; this.#i.ariaChecked = 'false'; }
});
customElements.define('x-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; }
});
customElements.define('x-named-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; this.#i.ariaLabel = 'Dark mode'; }
});
</script>`;

function componentPage(body) {
  return 'data:text/html,' + encodeURIComponent(
    `<!doctype html><html lang="en"><head><title>t</title>${COMPONENTS_SCRIPT}</head><body><main><h1>Hi</h1>${body}</main></body></html>`
  );
}

function srcdoc(html) {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function outcomeOf(result, ruleId) {
  const check = result.checksResults.find((r) => r.ruleId === ruleId);
  return check ? check.outcome : undefined;
}

test('A11yCoreBuilder: wcagLevel() reaches the engine: a contrast check at AA reports 1.4.3 and no 1.4.6', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><p>Text</p></main></body></html>');
    const results = await new A11yCoreBuilder({ page }).withRules('contrast-computable').wcagLevel('aa').analyze();
    assert.strictEqual(results.engine.wcagLevel, 'AA');
    assert.deepStrictEqual(results.rulesResults.map((r) => r.ruleId), ['wcag-1.4.3-contrast-minimum']);
    assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['contrast-computable']);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: a scan under emulated forced colors records engine.environment.forcedColors', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>');
    const results = await new A11yCoreBuilder({ page }).withRules('contrast-minimum').analyze();
    assert.strictEqual(results.engine.environment.forcedColors, 'active');

    await page.emulateMedia({ forcedColors: 'none' });
    const plain = await new A11yCoreBuilder({ page }).withRules('contrast-minimum').analyze();
    assert.strictEqual(plain.engine.environment.forcedColors, 'none');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook(): a component named through private internals is a question without it, and passes with it', async () => {
  const browser = await chromium.launch();
  try {
    const without = await browser.newPage();
    await without.goto(componentPage('<x-check role="checkbox"></x-check>'));
    const before = await new A11yCoreBuilder({ page: without }).logger(() => {}).analyze();
    assert.strictEqual(outcomeOf(before, 'binary-control-name-present'), 'cantTell');
    assert.strictEqual(before.engine.environment.internalsHook, undefined);

    const page = await browser.newPage();
    await A11yCoreBuilder.installInternalsHook(page);
    await page.goto(componentPage('<x-check role="checkbox"></x-check>'));
    const after = await new A11yCoreBuilder({ page }).analyze();
    assert.strictEqual(after.engine.environment.internalsHook, 'early');
    assert.strictEqual(outcomeOf(after, 'binary-control-name-present'), 'pass');
    assert.strictEqual(outcomeOf(after, 'aria-required-attr'), 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook(): on a BrowserContext, every page it opens has the hook', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await A11yCoreBuilder.installInternalsHook(context);
    for (const body of ['<x-check role="checkbox"></x-check>', '<x-named-toggle></x-named-toggle>']) {
      const page = await context.newPage();
      await page.goto(componentPage(body));
      const results = await new A11yCoreBuilder({ page }).withRules('binary-control-name-present').analyze();
      assert.strictEqual(results.engine.environment.internalsHook, 'early');
      assert.strictEqual(outcomeOf(results, 'binary-control-name-present'), 'pass');
    }
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook(): a component that is a switch only through its internals is checked as one', async () => {
  const browser = await chromium.launch();
  try {
    const without = await browser.newPage();
    await without.goto(componentPage('<x-toggle></x-toggle>'));
    const before = await new A11yCoreBuilder({ page: without }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(before, 'binary-control-name-present'), 'notApplicable', 'without the hook the role is not seen');

    const page = await browser.newPage();
    await A11yCoreBuilder.installInternalsHook(page);
    await page.goto(componentPage('<x-toggle></x-toggle>'));
    const unnamed = await new A11yCoreBuilder({ page }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(unnamed, 'binary-control-name-present'), 'fail');

    await page.goto(componentPage('<x-named-toggle></x-named-toggle>'));
    const named = await new A11yCoreBuilder({ page }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(named, 'binary-control-name-present'), 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook(): it reaches a same-origin frame', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await A11yCoreBuilder.installInternalsHook(page);
    const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
    await page.goto(componentPage(`<iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`));
    await page.waitForLoadState('load');
    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();
    assert.strictEqual(results.frames.length, 1);
    const frame = results.frames[0];
    assert.strictEqual(frame.engine.environment.internalsHook, 'early');
    assert.strictEqual(outcomeOf(frame, 'binary-control-name-present'), 'pass');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook(): called after goto, the loaded page has no hook; the next navigation has it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(componentPage('<x-check role="checkbox"></x-check>'));
    await A11yCoreBuilder.installInternalsHook(page);
    const loaded = await new A11yCoreBuilder({ page }).logger(() => {}).analyze();
    assert.strictEqual(loaded.engine.environment.internalsHook, undefined);

    await page.reload();
    const reloaded = await new A11yCoreBuilder({ page }).analyze();
    assert.strictEqual(reloaded.engine.environment.internalsHook, 'early');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installInternalsHook() throws a TypeError for anything but a Page or BrowserContext', () => {
  for (const bad of [undefined, null, {}, { evaluate() {} }]) {
    assert.throws(() => A11yCoreBuilder.installInternalsHook(bad), TypeError);
  }
});

test('A11yCoreBuilder: without the hook, analyze() says once per scan that it would let the engine read those components', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
    await page.goto(componentPage(`<x-check role="checkbox"></x-check><iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`));
    await page.waitForLoadState('load');
    await new A11yCoreBuilder({ page }).frames(true).analyze();
    const notes = warnings.filter((w) => /custom element was asked about/.test(w));
    assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
    assert.match(notes[0], /^@surea11y\/playwright \(data:text\/html,.*installInternalsHook\(\)/);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: plannedChecks() and plannedCriteria() list what analyze() then reports', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><img src="a.png"></main></body></html>');
    const builder = new A11yCoreBuilder({ page }).withWcag('2.2', 'AA');
    const results = await builder.analyze();
    const ids = (list, key) => list.map((e) => e[key]).sort();
    assert.deepStrictEqual(ids(builder.plannedChecks(), 'ruleId'), ids(results.checksResults, 'ruleId'));
    assert.deepStrictEqual(ids(builder.plannedCriteria(), 'id'), ids(results.rulesResults, 'ruleId'));
  } finally {
    await browser.close();
  }
});

// --- @surea11y/core 1.14: steps for questions, the listener and live-region hooks

function htmlPage(body, head = '') {
  return 'data:text/html,' + encodeURIComponent(
    `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><main><h1>Hi</h1>${body}</main></body></html>`
  );
}

test('A11yCoreBuilder: a question in the result says how to answer it, and formatFailures() lists it after the failures', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(htmlPage('<h3>Skipped</h3><img src="a.png">'));
    const results = await new A11yCoreBuilder({ page }).withRules(['heading-order', 'img-alt-present']).analyze();
    const [question] = results.checksResults.find((r) => r.ruleId === 'heading-order').occurrences;
    assert.strictEqual(question.lean.toward, 'fail');
    assert.ok(question.howToCheck.steps.length, 'the steps the in-page engine leaves out are added');
    const text = formatFailures(results, { howToCheck: true });
    assert.match(text, /^1\) img-alt-present \(serious\): /);
    assert.match(text, /\n2\) heading-order \(minor, likely fails\): /);
    assert.match(text, /\n {3}How to check:\n {5}1\. /);
  } finally {
    await browser.close();
  }
});

const SCRIPTED_BUTTON =
  '<div role="button" tabindex="0" class="save">Save</div>' +
  '<script>document.querySelector(".save").addEventListener("click", () => {});</script>';

test('A11yCoreBuilder.installListenerHook(): a button given its click listener from script is judged with it, and not without', async () => {
  const browser = await chromium.launch();
  try {
    const without = await browser.newPage();
    await without.goto(htmlPage(SCRIPTED_BUTTON));
    const before = await new A11yCoreBuilder({ page: without }).withRules('click-handler-keyboard-operable').logger(() => {}).analyze();
    assert.strictEqual(before.engine.environment.listenerHook, undefined);
    assert.notStrictEqual(outcomeOf(before, 'click-handler-keyboard-operable'), 'fail', 'without the hook the listener is not seen');

    const page = await browser.newPage();
    await A11yCoreBuilder.installListenerHook(page);
    await page.goto(htmlPage(SCRIPTED_BUTTON));
    const after = await new A11yCoreBuilder({ page }).withRules('click-handler-keyboard-operable').analyze();
    assert.strictEqual(after.engine.environment.listenerHook, 'early');
    assert.strictEqual(outcomeOf(after, 'click-handler-keyboard-operable'), 'fail');
    const [found] = after.checksResults[0].occurrences;
    assert.strictEqual(found.data.details.reasonCode, 'CLICK_HANDLER_NO_KEY_LISTENER');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.installListenerHook(): on a BrowserContext, every page it opens has the hook', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await A11yCoreBuilder.installListenerHook(context);
    const page = await context.newPage();
    await page.goto(htmlPage(SCRIPTED_BUTTON));
    const results = await new A11yCoreBuilder({ page }).withRules('click-handler-keyboard-operable').analyze();
    assert.strictEqual(results.engine.environment.listenerHook, 'early');
    assert.strictEqual(outcomeOf(results, 'click-handler-keyboard-operable'), 'fail');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.announcements(): what the live regions were given, each with its region, and null without the hook', async () => {
  const browser = await chromium.launch();
  try {
    const without = await browser.newPage();
    await without.goto(htmlPage('<div id="status" aria-live="polite"></div>'));
    assert.strictEqual(await A11yCoreBuilder.announcements(without), null);

    const page = await browser.newPage();
    await A11yCoreBuilder.installLiveRegionHook(page);
    await page.goto(htmlPage('<div id="status" aria-live="polite"></div><button>Save</button>'));
    await page.evaluate(() => { document.getElementById('status').textContent = 'Saved'; });
    const said = await A11yCoreBuilder.announcements(page);
    assert.deepStrictEqual(said.map((a) => ({ text: a.text, selector: a.selector })), [{ text: 'Saved', selector: '#status' }]);
    assert.strictEqual(said[0].politeness, 'polite');
    const results = await new A11yCoreBuilder({ page }).withRules('live-region-announcements').analyze();
    assert.strictEqual(results.engine.environment.liveRegionHook, 'early');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: the listener and live-region hook installers want a Page or BrowserContext, and add core\'s scripts', async () => {
  for (const method of ['installListenerHook', 'installLiveRegionHook']) {
    for (const bad of [undefined, null, {}, { evaluate() {} }]) {
      assert.throws(() => A11yCoreBuilder[method](bad), (e) => e instanceof TypeError && e.message.includes(method));
    }
  }
  const scripts = [];
  const fakePage = { addInitScript: async (s) => { scripts.push(s); } };
  await A11yCoreBuilder.installListenerHook(fakePage);
  await A11yCoreBuilder.installLiveRegionHook(fakePage);
  const core = require('@surea11y/core');
  assert.deepStrictEqual(scripts, [{ content: core.listenerHookScript() }, { content: core.liveRegionHookScript() }]);
});

test('A11yCoreBuilder.installLiveRegionHook(): a region added with its text already in it is asked about', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await A11yCoreBuilder.installLiveRegionHook(page);
    await page.goto(htmlPage('<div id="toasts"></div>'));
    await page.evaluate(() => {
      document.getElementById('toasts').innerHTML = '<div role="status">Copied</div>';
    });
    const results = await new A11yCoreBuilder({ page }).withRules('live-region-announcements').analyze();
    assert.strictEqual(results.engine.environment.liveRegionHook, 'early');
    const check = results.checksResults.find((r) => r.ruleId === 'live-region-announcements');
    assert.strictEqual(check.outcome, 'cantTell');
    assert.deepStrictEqual(
      check.occurrences.map((o) => [o.data.details.reasonCode, o.data.details.text]),
      [['LIVE_REGION_INSERTED_WITH_CONTENT', 'Copied']]
    );
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: without the listener hook, analyze() says once per scan which findings it would have decided', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(htmlPage('<div role="button" tabindex="0" onclick="void save()">Save</div>'));
    await new A11yCoreBuilder({ page }).withRules('click-handler-keyboard-operable').analyze();
    const notes = warnings.filter((w) => /judged without seeing the listeners the page adds from script/.test(w));
    assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
    assert.match(notes[0], /installListenerHook\(\)/);
  } finally {
    await browser.close();
  }
});

// Reads well in the light scheme; in the dark one its text is #444 on #222.
const DARK_CONTRAST = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html lang="en"><head><title>t</title><style>' +
  'body { color: #111; background: #fff } ' +
  '@media (prefers-color-scheme: dark) { body { color: #444; background: #222 } }' +
  '</style></head><body><main><h1>Hi</h1><p id="note">Read me</p></main></body></html>'
);

test('A11yCoreBuilder.conditions(): a failure only in dark mode fails the merged result, labelled, and the page is put back', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await page.goto(DARK_CONTRAST);
    const results = await new A11yCoreBuilder({ page })
      .withRules('contrast-minimum')
      .conditions([{ colorScheme: 'dark' }, { width: 320 }])
      .analyze();
    const check = results.checksResults.find((r) => r.ruleId === 'contrast-minimum');
    assert.strictEqual(check.outcome, 'fail');
    assert.ok(check.occurrences.length > 0);
    for (const o of check.occurrences) assert.deepStrictEqual(o.conditions, ['dark']);
    assert.deepStrictEqual(
      results.conditionRuns.map((r) => [r.condition, r.environment.viewport.width, r.environment.colorScheme]),
      [['default', 1024, 'light'], ['dark', 1024, 'dark'], ['width 320', 320, 'light']]
    );
    assert.deepStrictEqual(page.viewportSize(), { width: 1024, height: 700 });
    assert.strictEqual(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), false);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.conditions(): a dark scheme the caller emulated stays dark, and a width-only condition scans in it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await page.goto(DARK_CONTRAST);
    await page.emulateMedia({ colorScheme: 'dark' });
    const results = await new A11yCoreBuilder({ page })
      .withRules('contrast-minimum')
      .conditions([{ colorScheme: 'light' }, { width: 320 }])
      .analyze();
    assert.deepStrictEqual(
      results.conditionRuns.map((r) => [r.condition, r.environment.colorScheme]),
      [['default', 'dark'], ['light', 'light'], ['width 320', 'dark']]
    );
    assert.strictEqual(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder.conditions(): checks its list, and refuses frames(true) beside it', async () => {
  const builder = new A11yCoreBuilder({ page: { evaluate() {} } });
  assert.throws(() => builder.conditions([{ colorScheme: 'sepia' }]), TypeError);
  await assert.rejects(builder.conditions([{ width: 320 }]).frames(true).analyze(), /can't be combined yet/);
});
