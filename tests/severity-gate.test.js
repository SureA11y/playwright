'use strict';

// getGatingFailures() and SEVERITIES, re-exported from @surea11y/binding-base
// 1.6.0, and formatFailures()'s failOnSeverity. Skipped with an older
// binding-base, which has neither.

const test = require('node:test');
const assert = require('node:assert');
const { getGatingFailures, formatFailures, SEVERITIES } = require('../src/index.js');

const NEEDS_GATE = typeof getGatingFailures !== 'function' && 'needs @surea11y/binding-base 1.6.0';

const result = {
  checksResults: [
    { ruleId: 'img-alt-present', title: 'Images', outcome: 'fail', severity: 'critical', occurrences: [{ selector: 'img', summary: 'No alt.' }] },
    { ruleId: 'aria-allowed-attr', title: 'ARIA', outcome: 'fail', severity: 'moderate', occurrences: [{ selector: 'div', summary: 'Not allowed.' }] },
    { ruleId: 'region', title: 'Region', outcome: 'cantTell', severity: 'serious', occurrences: [{ selector: 'span', summary: 'Outside.' }] }
  ]
};

test('getGatingFailures(): only the failing rules at the level or above, and formatFailures() marks the rest', { skip: NEEDS_GATE }, () => {
  assert.deepStrictEqual(SEVERITIES, ['minor', 'moderate', 'serious', 'critical']);
  assert.deepStrictEqual(getGatingFailures(result).map((c) => c.ruleId), ['img-alt-present', 'aria-allowed-attr']);
  assert.deepStrictEqual(getGatingFailures(result, { failOnSeverity: 'serious' }).map((c) => c.ruleId), ['img-alt-present']);
  assert.match(
    formatFailures(result, { failOnSeverity: 'serious' }),
    /aria-allowed-attr \(moderate, below failOnSeverity serious, does not fail the test\)/
  );
  assert.throws(() => getGatingFailures(result, { failOnSeverity: 'high' }), TypeError);
});
