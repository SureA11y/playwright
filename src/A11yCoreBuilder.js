'use strict';

const { runa11yCoreInPage } = require('a11y-core');
const { A11yCoreBuilderBase } = require('a11y-core-binding-base');

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
 * Extends `A11yCoreBuilderBase` (from `a11y-core-binding-base`), which owns
 * every method with no driver-specific work at all -- `include()`/
 * `exclude()`/`withTags()`/`disableTags()`/`withRules()`/`disableRules()`/
 * `options()`/`reportOnly()`/`elementRef()`/`frames()`/`withCustomRules()`'s
 * validation (including the default customRules stringification, correct
 * here since Playwright's `page.evaluate()` crosses a real serialization
 * boundary), and `_buildEngineArgs()`. This class adds exactly the parts
 * that are genuinely Playwright-specific: `analyze()`'s injection mechanics
 * (including the single-argument `page.evaluate()` wrapper below), frame
 * traversal, and `_attachElementRefs()`. See
 * `../a11y-core-binding-base/README.md` for what's shared and why.
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
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- a11y-core's own deliberate "not a
 * violations-only list" design (see a11y-core's docs/OUTPUT_SCHEMA.md).
 * Opt in to a lighter payload with `.reportOnly(['fail', 'cantTell'])`,
 * which post-filters `checksResults` by `outcome` (applied per-frame when
 * combined with `.frames(true)`, since `checksResults` lives at
 * `results.topFrame` / each `results.frames[i]` in that shape, not at the
 * top level):
 *
 * const results = await new A11yCoreBuilder({ page })
 *   .reportOnly(['fail', 'cantTell'])
 *   .analyze();
 *
 * Opt in to a live `ElementHandle` per occurrence (instead of just a CSS
 * selector string) with `.elementRef(true)`, so you can act on the flagged
 * element directly rather than re-resolving its selector yourself:
 *
 * const results = await new A11yCoreBuilder({ page }).elementRef(true).analyze();
 * const [firstFail] = results.checksResults.filter(r => r.outcome === 'fail');
 * await firstFail.occurrences[0].elementHandle.screenshot({ path: 'flagged.png' });
 *
 * Register your own rule(s) for just this scan with
 * `.withCustomRules([...])` (a11y-core's `engineOptions.customRules`
 * escape hatch, axe's `configure({ rules })` equivalent -- see
 * a11y-core's docs/ENGINE_OPTIONS.md). Pass a real, live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * a11y-core needs on this side of the page.evaluate() JSON boundary for
 * you, so you don't have to remember to call .toString() yourself:
 *
 * const results = await new A11yCoreBuilder({ page })
 *   .withCustomRules({
 *     id: 'my-org-custom-rule',
 *     meta: { title: 'My custom rule', tags: ['custom'] },
 *     runInPage(ctx) {
 *       const el = ctx.document.querySelector('.my-widget');
 *       return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
 *     }
 *   })
 *   .analyze();
 *
 * Create one builder per scan. This is a mutable object with no reset
 * between analyze() calls: include()/exclude()/withRules()/disableRules()/
 * withTags()/disableTags()/options()/withCustomRules() all push onto or
 * merge into internal state that persists for the instance's lifetime, so
 * calling one of them again before a second analyze() call accumulates on
 * top of the first scan's scope rather than replacing it (intentional for
 * "call include() several times for one scan" -- see above -- but a footgun
 * if you hold one instance across multiple assertions).
 * reportOnly()/frames()/elementRef() are the exception: each call replaces
 * the previous value rather than merging with it.
 */
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * @param {{ page: import('playwright').Page, url?: string }} opts
   *   `page` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ page, url } = {}) {
    super({ url });
    if (!page || typeof page.evaluate !== 'function') {
      throw new Error('A11yCoreBuilder requires { page } (a Playwright Page, with an .evaluate() method).');
    }
    this._page = page;
  }

  /**
   * Runs the scan and returns a11y-core's native result object.
   * @returns {Promise<object>} see a11y-core's docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const { contextSelector, engineOptions, runOnly } = this._buildEngineArgs();

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
      const result = await frameOrPage.evaluate(wrapperFn, {
        url: frameUrl,
        contextSelector,
        engineOptions,
        runOnly
      });
      return this._elementRef ? this._attachElementRefs(frameOrPage, result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await runInFrame(this._page));
    }

    const mainFrame = this._page.mainFrame();
    const topFrame = this._applyReportOnly(await runInFrame(mainFrame));

    // page.frames() includes the main frame itself -- exclude it here since
    // it's already covered by topFrame above, so callers don't have to
    // de-duplicate it themselves out of the frames array.
    const subFrames = this._page.frames().filter((f) => f !== mainFrame);
    const frames = [];
    for (const frame of subFrames) {
      try {
        frames.push(this._applyReportOnly(await runInFrame(frame)));
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

  /**
   * Resolves occurrence.selector to a live ElementHandle for every
   * fail/cantTell occurrence, scoped to frameOrPage's own document (a
   * Playwright Page and Frame both expose the same .$(selector) shape).
   * Mutates and returns the same result object -- it's a fresh object from
   * this scan, not shared external state.
   */
  async _attachElementRefs(frameOrPage, result) {
    if (!Array.isArray(result.checksResults)) return result;
    for (const check of result.checksResults) {
      if (!Array.isArray(check.occurrences) || !check.occurrences.length) continue;
      for (const occurrence of check.occurrences) {
        // Most occurrences carry a concrete element selector, but a page-wide
        // finding with no single target element (e.g. some `manual`/cantTell
        // rules) can carry "" -- not every occurrence resolves to one element,
        // so leave elementHandle null rather than passing "" to .$() (which
        // throws, it's not a valid CSS selector).
        occurrence.elementHandle = occurrence.selector ? await frameOrPage.$(occurrence.selector) : null;
      }
    }
    return result;
  }
}

module.exports = { A11yCoreBuilder };
