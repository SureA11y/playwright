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
 * Opt in to scanning every frame on the page (including cross-origin
 * iframes) via .frames(true):
 *
 * const results = await new A11yCoreBuilder({ page }).frames(true).analyze();
 * // results.topFrame        -- same shape as the single-frame case above
 * // results.frames          -- array of the same native result shape, one per sub-frame
 *
 * Unlike axe-core (which needs a postMessage-based protocol,
 * runPartial/finishRun, to reach cross-origin iframes, since it's injected
 * as a plain <script> and is fully subject to the browser's same-origin
 * policy), this doesn't need any a11y-core engine support: Playwright
 * drives every frame via CDP at the automation-process level, not as
 * in-page script, so cross-origin frame.evaluate() already just works --
 * verified empirically, see ../ROADMAP.md gap #1 for the full story.
 * Default off, so plain .analyze() keeps returning the single native result
 * object it always has.
 *
 * Known v1 limitations (see ../ROADMAP.md for the full, prioritized list and
 * the reasoning behind each):
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
    this._scanFrames = false;
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
   * Opt in to also scanning every sub-frame on the page (including
   * cross-origin iframes -- see this file's own header comment for why
   * that needs no a11y-core engine support). Default off; when off,
   * analyze() returns the same single native result object it always has.
   * When on, analyze() instead returns { topFrame, frames }.
   */
  frames(enabled = true) {
    this._scanFrames = !!enabled;
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

    // Playwright's page.evaluate(fn, arg) (and frame.evaluate(fn, arg), same
    // signature) only accepts ONE arg value -- page.evaluate(fn, a, b, c, d)
    // throws "Too many arguments. If you need to pass more than 1 argument
    // to the function wrap them in an object." (confirmed against a real
    // Playwright page -- see a11y-core's own docs/INTEGRATION.md for the
    // full story, including why this differs from Puppeteer's variadic
    // form). runa11yCoreInPage itself takes 4 positional args, so wrap it in
    // a single-arg function that destructures one options object, embedding
    // runa11yCoreInPage's own source via .toString() so the wrapper stays
    // fully self-contained once serialized into the page (it has zero free
    // vars of its own -- see a11y-core's docs/RULE_AUTHORING.md for why that
    // matters).
    const wrapperSource = `(args) => {
      const runa11yCoreInPage = ${runa11yCoreInPage.toString()};
      return runa11yCoreInPage(args.url, args.contextSelector, args.engineOptions, args.runOnly);
    }`;
    // eslint-disable-next-line no-eval
    const wrapperFn = eval(wrapperSource);

    // A Playwright Page and a Frame both expose the same .evaluate(fn, arg)
    // and .url() shape, so this works unchanged for either.
    const runInFrame = async (frameOrPage) => {
      const frameUrl = this._url || (typeof frameOrPage.url === 'function' ? frameOrPage.url() : null);
      return frameOrPage.evaluate(wrapperFn, {
        url: frameUrl,
        contextSelector,
        engineOptions,
        runOnly
      });
    };

    if (!this._scanFrames) {
      return runInFrame(this._page);
    }

    const mainFrame = this._page.mainFrame();
    const topFrame = await runInFrame(mainFrame);

    // page.frames() includes the main frame itself -- exclude it here since
    // it's already covered by topFrame above, so callers don't have to
    // de-duplicate it themselves out of the frames array.
    const subFrames = this._page.frames().filter((f) => f !== mainFrame);
    const frames = [];
    for (const frame of subFrames) {
      try {
        frames.push(await runInFrame(frame));
      } catch (e) {
        // A frame can detach/navigate away mid-scan, or be a sandboxed
        // frame the browser blocks scripting in -- don't let one bad frame
        // abort the whole multi-frame scan; report it and keep going.
        frames.push({
          url: (typeof frame.url === 'function' ? frame.url() : null),
          error: (e && e.message) || String(e)
        });
      }
    }

    return { topFrame, frames };
  }
}

module.exports = { A11yCoreBuilder };
