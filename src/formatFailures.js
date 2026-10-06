'use strict';

// Re-exported from @surea11y/binding-base, which now holds the single
// canonical copy shared across every surea11y binding -- see
// ../binding-base/README.md for the full rationale. Kept as a
// real file here (not just re-exporting straight from src/index.js) so
// `require('@surea11y/playwright/src/formatFailures')` keeps working for
// anyone importing the submodule path directly. Takes a whole scan result
// as well as its checksResults (binding-base 1.2.0 and later).
const { formatFailures } = require('@surea11y/binding-base');

module.exports = { formatFailures };
