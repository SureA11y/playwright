'use strict';

// Re-exported from @surea11y/binding-base, which now holds the single
// canonical copy shared across every surea11y binding -- see
// https://github.com/rumoroso/surea11y-core-binding-base for the full
// rationale. Kept as a real file here (not just re-exporting straight
// from src/index.js) so
// `require('@surea11y/playwright/src/formatFailures')` keeps working for
// anyone importing the submodule path directly.
const { formatFailures } = require('@surea11y/binding-base');

module.exports = { formatFailures };
