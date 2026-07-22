'use strict';

/**
 * Turns a11y-core's checksResults array into a short, human-readable block
 * -- one entry per occurrence, not per rule, since a single rule can flag
 * several elements. Meant to be handed to an assertion library's own
 * failure-message parameter, e.g.:
 *
 *   const results = await new A11yCoreBuilder({ page }).reportOnly(['fail']).analyze();
 *   expect(results.checksResults, formatFailures(results.checksResults)).toEqual([]);
 *
 * Deliberately a plain function, not a custom `expect` matcher -- it has no
 * dependency on any particular assertion library (Playwright's `expect`,
 * Jest, Vitest, or a hand-rolled `if`/`throw` all work the same way), which
 * matches this project's own test-runner-agnostic stance elsewhere (see
 * examples/playwright-test-example.spec.js's note on `playwright/test` vs
 * `@playwright/test`).
 *
 * @param {Array<object>} checksResults a11y-core's checksResults array (or
 *   any subset of it, e.g. already passed through .reportOnly()) -- see
 *   ../a11y-core/docs/OUTPUT_SCHEMA.md for the shape.
 * @param {{ outcomes?: string[] }} [opts] Which outcomes to include.
 *   Defaults to ['fail', 'cantTell'] -- the two outcomes that ever carry
 *   occurrences (see OUTPUT_SCHEMA.md's note on `pass`/`notApplicable`
 *   always having occurrences: []).
 * @returns {string}
 */
function formatFailures(checksResults, { outcomes = ['fail', 'cantTell'] } = {}) {
  const relevant = checksResults.filter((r) => outcomes.includes(r.outcome));

  const lines = [];
  let n = 0;
  for (const check of relevant) {
    if (!check.occurrences.length) {
      // A thrown rule surfaces as outcome: "cantTell" with occurrences: []
      // and error set to the exception message (see OUTPUT_SCHEMA.md) --
      // still worth surfacing rather than silently dropping.
      n += 1;
      lines.push(`${n}) ${check.ruleId} (${check.severity}): ${check.error || check.title}`);
      continue;
    }
    for (const occurrence of check.occurrences) {
      n += 1;
      lines.push(`${n}) ${check.ruleId} (${check.severity}): ${occurrence.summary}`);
      if (occurrence.selector) lines.push(`   at ${occurrence.selector}`);
      if (occurrence.hint) lines.push(`   ${occurrence.hint}`);
    }
  }

  return lines.length ? lines.join('\n') : 'No accessibility violations found.';
}

module.exports = { formatFailures };
