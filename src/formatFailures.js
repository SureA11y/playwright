'use strict';

// Re-exported from a11y-labs-binding-base, which now holds the single
// canonical copy shared across every a11y-labs binding -- see
// ../ROADMAP.md's note on the shared-package extraction, and
// ../a11y-labs-binding-base/README.md for the full rationale. Kept as a
// real file here (not just re-exporting straight from src/index.js) so
// `require('a11y-labs-playwright/src/formatFailures')` keeps working for
// anyone importing the submodule path directly.
const { formatFailures } = require('@a11y-labs/binding-base');

module.exports = { formatFailures };
