'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('../src/index.js');

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
// returns false, a11y-labs reports 'notApplicable' WITHOUT ever invoking
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

test('A11yCoreBuilder.analyze() scans a real page and returns a11y-labs\'s native result shape', async () => {
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

    // a11y-labs applies excludeRuleIds *after* includeRuleIds (see
    // ../a11y-labs/docs/ENGINE_OPTIONS.md) -- disableRules() should win over
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

test('A11yCoreBuilder: withRules() and withTags() combined require BOTH to match (a11y-labs\'s default "and" includeMode)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src=x.png><button></button></body></html>');

    // a11y-labs's default includeMode is 'and' when both an ID include and a
    // tag include are given (see ../a11y-labs/docs/ENGINE_OPTIONS.md) -- this
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
    // under (see a11y-labs's docs/OUTPUT_SCHEMA.md) -- checking that,
    // rather than just presence, confirms .options() really reached the
    // engine instead of being silently dropped.
    assert.strictEqual(rule.engineOptions.locale, 'fr');
  } finally {
    await browser.close();
  }
});

test('A11yCoreBuilder: options({ customRules }) registers a runtime custom rule via a11y-labs\'s engineOptions passthrough', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><div class="my-widget"></div></body></html>');

    // No dedicated builder method for this yet (see ../ROADMAP.md gap #4) --
    // .options() already forwards arbitrary engineOptions, including
    // a11y-labs's customRules runtime-registration escape hatch (see
    // ../a11y-labs/docs/ENGINE_OPTIONS.md).
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

test('A11yCoreBuilder: frames(true) scans a genuinely cross-origin iframe (no a11y-labs engine support needed for this -- see ../ROADMAP.md gap #1)', async () => {
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
