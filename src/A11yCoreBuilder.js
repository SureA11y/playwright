'use strict';

const { runa11yCoreInPage } = require('a11y-core');

/**
 * Playwright binding for a11y-core -- scans a real, already-rendered page.
 *
 * const results = await new A11yCoreBuilder({ page })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['a11ycore-meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is a11y-core's own native result shape (checksResults /
 * rulesResults -- see a11y-core's docs/OUTPUT_SCHEMA.md), not axe-core's
 * violations/passes/incomplete/inapplicable shape. Method names are modeled
 * on axe-core's AxeBuilder for migration ease, but the richer native schema
 * (severity, confidence, occurrences, policy contract, WCAG SC mappings) is
 * kept as-is rather than reshaped to match axe.
 *
 * Known v1 limitations (see ../ROADMAP.md for the full, prioritized list and
 * the reasoning behind each):
 * - No cross-frame/iframe traversal -- only scans the top-level page/frame
 *   passed in via `page`. Real content sometimes lives in iframes (cookie
 *   consent dialogs, payment widgets) and won't be scanned yet.
 * - No `elementRef` support -- occurrences carry a CSS selector + HTML
 *   snippet, not a live element handle.
 * - No `.reportOnly()`-style result filtering yet -- `analyze()` always
 *   returns every rule's outcome (a11y-core's own deliberate "not a
 *   violations-only list" design), which may be more verbose than axe
 *   consumers expect by default.
 */
class A11yCoreBuilder {
  /**
   * @param {{ page: import('playwright').Page, url?: string }} opts
   *   `page` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ page, url } = {}) {
    if (!page || typeof page.evaluate !== 'function') {
      throw new Error('A11yCoreBuilder requires { page } (a Playwright Page, with an .evaluate() method).');
    }
    this._page = page;
    this._url = url || null;
    this._includeSelectors = [];
    this._excludeSelectors = [];
    this._includeRuleIds = [];
    this._excludeRuleIds = [];
    this._tags = [];
    this._excludeTags = [];
    this._engineOptions = {};
  }

  /**
   * Scope the scan to one region. Call multiple times to scan several,
   * possibly disjoint regions in one run (a11y-core's contextSelector
   * accepts an array of selectors for exactly this -- see a11y-core's
   * docs/ENGINE_OPTIONS.md).
   */
  include(selector) {
    if (selector) this._includeSelectors.push(selector);
    return this;
  }

  /** Skip elements matching this selector anywhere in the scanned scope. */
  exclude(selector) {
    if (selector) this._excludeSelectors.push(selector);
    return this;
  }

  /** Only run rules carrying at least one of these tags. */
  withTags(tags) {
    this._tags = this._tags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags) {
    this._excludeTags = this._excludeTags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Only run these specific rule IDs (accepts with or without the a11ycore- prefix). */
  withRules(ruleIds) {
    this._includeRuleIds = this._includeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds) {
    this._excludeRuleIds = this._excludeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...) -- see a11y-core's docs/ENGINE_OPTIONS.md. */
  options(partialEngineOptions) {
    this._engineOptions = { ...this._engineOptions, ...(partialEngineOptions || {}) };
    return this;
  }

  /**
   * Runs the scan and returns a11y-core's native result object.
   * @returns {Promise<object>} see a11y-core's docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const contextSelector = this._includeSelectors.length
      ? (this._includeSelectors.length === 1 ? this._includeSelectors[0] : this._includeSelectors)
      : null;

    const engineOptions = { ...this._engineOptions };
    if (this._excludeSelectors.length) {
      engineOptions.excludeSelectors = this._excludeSelectors;
    }

    const hasRunOnly = this._includeRuleIds.length || this._excludeRuleIds.length || this._tags.length || this._excludeTags.length;
    const runOnly = hasRunOnly
      ? {
        includeRuleIds: this._includeRuleIds.length ? this._includeRuleIds : undefined,
        excludeRuleIds: this._excludeRuleIds.length ? this._excludeRuleIds : undefined,
        tags: this._tags.length ? this._tags : undefined,
        excludeTags: this._excludeTags.length ? this._excludeTags : undefined
      }
      : null;

    const url = this._url || (typeof this._page.url === 'function' ? this._page.url() : null);

    // Playwright's page.evaluate(fn, arg) only accepts ONE arg value --
    // page.evaluate(fn, a, b, c, d) throws "Too many arguments. If you need
    // to pass more than 1 argument to the function wrap them in an object."
    // (confirmed against a real Playwright page -- see a11y-core's own
    // docs/INTEGRATION.md for the full story, including why this differs
    // from Puppeteer's variadic form). runa11yCoreInPage itself takes 4
    // positional args, so wrap it in a single-arg function that
    // destructures one options object, embedding runa11yCoreInPage's own
    // source via .toString() so the wrapper stays fully self-contained once
    // serialized into the page (it has zero free vars of its own -- see
    // a11y-core's docs/RULE_AUTHORING.md for why that matters).
    const wrapperSource = `(args) => {
      const runa11yCoreInPage = ${runa11yCoreInPage.toString()};
      return runa11yCoreInPage(args.url, args.contextSelector, args.engineOptions, args.runOnly);
    }`;
    // eslint-disable-next-line no-eval
    const wrapperFn = eval(wrapperSource);

    return this._page.evaluate(wrapperFn, {
      url,
      contextSelector,
      engineOptions,
      runOnly
    });
  }
}

module.exports = { A11yCoreBuilder };
