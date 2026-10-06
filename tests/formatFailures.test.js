'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { A11yCoreBuilder, formatFailures, formatOccurrenceLocation, getScanGaps } = require('../src/index.js');
const CORE_VERSION = require('@surea11y/core/package.json').version;

test('formatFailures(): returns a fixed message when there are no violations', () => {
  assert.strictEqual(formatFailures([]), 'No accessibility violations found.');
  assert.strictEqual(
    formatFailures([{ ruleId: 'img-alt-present', outcome: 'pass', occurrences: [] }]),
    'No accessibility violations found.'
  );
});

test('formatFailures(): formats one line block per occurrence, numbered, with rule/severity/selector/hint', () => {
  const checksResults = [
    {
      ruleId: 'img-alt-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [
        { selector: 'html > body > img', summary: 'Missing alt attribute on <img>.', hint: 'Add an alt attribute.' }
      ]
    }
  ];

  assert.strictEqual(
    formatFailures(checksResults),
    '1) img-alt-present (serious): Missing alt attribute on <img>.\n' +
    '   at html > body > img\n' +
    '   Add an alt attribute.'
  );
});

test('formatFailures(): numbers occurrences across multiple rules and multiple occurrences of the same rule', () => {
  const checksResults = [
    {
      ruleId: 'img-alt-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [
        { selector: '#a img', summary: 'Missing alt.', hint: 'Add alt.' },
        { selector: '#b img', summary: 'Missing alt.', hint: 'Add alt.' }
      ]
    },
    {
      ruleId: 'button-name-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [{ selector: 'html > body > button', summary: 'No accessible name.', hint: 'Add a label.' }]
    }
  ];

  const output = formatFailures(checksResults);
  assert.ok(output.startsWith('1) img-alt-present'));
  assert.ok(output.includes('2) img-alt-present'));
  assert.ok(output.includes('3) button-name-present'));
});

test('formatFailures(): ignores pass/notApplicable entries and respects a custom outcomes filter', () => {
  const checksResults = [
    { ruleId: 'a', outcome: 'pass', occurrences: [] },
    { ruleId: 'b', outcome: 'notApplicable', occurrences: [] },
    {
      ruleId: 'c',
      outcome: 'cantTell',
      severity: 'moderate',
      occurrences: [{ selector: 'html > body', summary: 'Needs human review.', hint: 'Check manually.' }]
    }
  ];

  // Default outcomes (['fail', 'cantTell']) picks up the cantTell entry.
  assert.ok(formatFailures(checksResults).includes('c'));

  // Narrowing to just 'fail' drops it, since there's no fail entry here.
  assert.strictEqual(formatFailures(checksResults, { outcomes: ['fail'] }), 'No accessibility violations found.');
});

test('formatFailures(): surfaces a thrown rule (occurrences: [], error set) instead of silently dropping it', () => {
  const checksResults = [
    {
      ruleId: 'broken-rule',
      outcome: 'cantTell',
      severity: 'serious',
      title: 'A rule that threw',
      occurrences: [],
      error: 'TypeError: something exploded'
    }
  ];

  const output = formatFailures(checksResults);
  assert.strictEqual(output, '1) broken-rule (serious): TypeError: something exploded');
});

test('formatFailures(): works end-to-end against a real scan\'s checksResults', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();
    const output = formatFailures(results.checksResults);

    assert.ok(output.includes('img-alt-present'));
    assert.ok(output.includes('button-name-present'));
    assert.ok(output.includes('html > body > img'));
  } finally {
    await browser.close();
  }
});

test('formatFailures(result): an include() scope that matched nothing does not read as clean', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"></body></html>');

    const results = await new A11yCoreBuilder({ page }).include('#mian').reportOnly(['fail']).analyze();

    // Since @surea11y/core 1.10.0 nothing is scanned, so nothing fails.
    assert.deepStrictEqual(results.checksResults, []);
    assert.deepStrictEqual(results.contextMatch, { elementCount: 0, unmatchedSelectors: ['#mian'] });
    const gaps = getScanGaps(results);
    assert.deepStrictEqual(gaps.map((g) => g.kind), ['context-not-found']);
    assert.deepStrictEqual(gaps[0].selectors, ['#mian']);

    const output = formatFailures(results);
    assert.ok(!output.includes('No accessibility violations found.'), output);
    assert.ok(output.includes('Nothing was scanned'), output);
    assert.ok(output.includes('"#mian"'), output);
    assert.ok(output.endsWith(`Scanned with @surea11y/core ${CORE_VERSION}.`), output);
  } finally {
    await browser.close();
  }
});

test('formatFailures(result): names a custom rule that did not run', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><button>OK</button></body></html>');

    // The raw options() passthrough skips withCustomRules()' own checks, so
    // the engine is the one that leaves this rule out.
    const results = await new A11yCoreBuilder({ page })
      .options({ customRules: [{ id: 'never-runs', meta: { title: 'Never runs' }, runInPage: 'not a function' }] })
      .reportOnly(['fail'])
      .analyze();

    assert.deepStrictEqual(results.skippedCustomRules.map((r) => r.id), ['never-runs']);
    const gaps = getScanGaps(results);
    assert.deepStrictEqual(gaps.map((g) => g.kind), ['custom-rule-skipped']);
    assert.ok(formatFailures(results).includes('Custom rule "never-runs" did not run'));
  } finally {
    await browser.close();
  }
});

test('formatFailures(result): locates a shadow-DOM finding through its shadow host', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<html><body><my-card id="card"></my-card>' +
      '<script>document.getElementById("card").attachShadow({ mode: "open" }).innerHTML = \'<img src="x.png">\';</script>' +
      '</body></html>'
    );

    const results = await new A11yCoreBuilder({ page }).withRules(['img-alt-present']).reportOnly(['fail']).analyze();
    const [occurrence] = results.checksResults[0].occurrences;

    const location = formatOccurrenceLocation(occurrence);
    assert.ok(location.startsWith('#card >>> '), location);
    assert.ok(formatFailures(results).includes(`   at ${location}`));
  } finally {
    await browser.close();
  }
});

test('formatFailures()/getScanGaps(): a frames(true) result is refused, not formatted as a clean scan', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<html><body><img src="x.png"></body></html>');

    const results = await new A11yCoreBuilder({ page }).frames(true).analyze();

    assert.throws(() => formatFailures(results), TypeError);
    assert.throws(() => getScanGaps(results), TypeError);
    assert.ok(formatFailures(results.topFrame).includes('img-alt-present'));
  } finally {
    await browser.close();
  }
});
