'use strict';

const { runa11yCoreInPage } = require('@surea11y/core');
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement,
  getScanGaps
} = require('@surea11y/binding-base');

// Playwright's page.evaluate(fn, arg) (and frame.evaluate(fn, arg), same
// signature) only accepts ONE arg value -- page.evaluate(fn, a, b, c, d)
// throws "Too many arguments. If you need to pass more than 1 argument to
// the function wrap them in an object." (confirmed against a real Playwright
// page -- see ../core/docs/INTEGRATION.md for the full story, including why
// this differs from Puppeteer's variadic form). The scan takes 4 positional
// args, so wrap it in a single-arg function that destructures one options
// object, embedding the scan's own source so the wrapper stays fully
// self-contained once serialized into the page (it has zero free vars of
// its own -- see ../core/docs/RULE_AUTHORING.md for why that matters).
//
// The scan is core's runa11yCoreInPage wrapped by createInPageScan(), which
// returns an engine error (INVALID_RUN_ONLY, INVALID_CONTEXT_SELECTOR) as a
// plain object instead of throwing it: page.evaluate() keeps a thrown
// error's message but drops its `code`. rethrowEngineError() below throws
// it again on this side as an EngineError with `code` (and `selector`).
const inPageScan = createInPageScan(runa11yCoreInPage);
// eslint-disable-next-line no-eval
const scanInPage = eval(`(args) => {
  const inPageScan = ${inPageScan.toString()};
  return inPageScan(args.url, args.contextSelector, args.engineOptions, args.runOnly);
}`);

// Finds an occurrence's element through its shadow hosts. Since
// @surea11y/core 1.10.0 an occurrence inside a shadow tree carries
// `shadowHostSelectors`, and its `selector` holds only inside the last
// host's shadow root, so frame.$(selector) finds another element or none.
// Same single-argument wrapping as scanInPage, for evaluateHandle().
// eslint-disable-next-line no-eval
const findOccurrenceElement = eval(`(args) => {
  const queryOccurrenceElement = ${queryOccurrenceElement.toString()};
  return queryOccurrenceElement(args.selector, args.shadowHostSelectors);
}`);

/**
 * Playwright binding for surea11y -- scans a real, already-rendered page.
 *
 * const results = await new A11yCoreBuilder({ page })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is @surea11y/core's own native result shape (checksResults /
 * rulesResults -- see ../core/docs/OUTPUT_SCHEMA.md), not the
 * violations/passes/incomplete/inapplicable shape used by other tools in
 * this space. Method names are modeled on common conventions in this space
 * for migration ease, but the richer native schema (severity, confidence,
 * occurrences, policy contract, WCAG SC mappings) is kept as-is rather than
 * reshaped to match.
 *
 * Extends `A11yCoreBuilderBase` (from `@surea11y/binding-base`), which owns
 * every method with no driver-specific work at all -- `include()`/
 * `exclude()`/`withTags()`/`disableTags()`/`withRules()`/`disableRules()`/
 * `options()`/`reportOnly()`/`elementRef()`/`frames()`/`withCustomRules()`'s
 * validation (including the default customRules stringification, correct
 * here since Playwright's `page.evaluate()` crosses a real serialization
 * boundary), and `_buildEngineArgs()`. This class adds exactly the parts
 * that are genuinely Playwright-specific: `analyze()`'s injection mechanics
 * (including the single-argument `page.evaluate()` wrapper below), frame
 * traversal, and `_attachElementRefs()`. See
 * `../binding-base/README.md` for what's shared and why.
 *
 * Opt in to scanning every frame on the page (including cross-origin
 * iframes) via .frames(true):
 *
 * const results = await new A11yCoreBuilder({ page }).frames(true).analyze();
 * // results.topFrame        -- same shape as the single-frame case above
 * // results.frames          -- array of the same native result shape, one per sub-frame
 *
 * include() scopes the top frame only; every sub-frame is scanned whole.
 *
 * Unlike script-injection-based accessibility engines (which need a
 * postMessage-based protocol, runPartial/finishRun, to reach cross-origin
 * iframes, since they're injected as a plain <script> and are fully subject
 * to the browser's same-origin policy), this doesn't need any @surea11y/core
 * engine support: Playwright
 * drives every frame via CDP at the automation-process level, not as
 * in-page script, so cross-origin frame.evaluate() already just works --
 * verified empirically.
 * Default off, so plain .analyze() keeps returning the single native result
 * object it always has.
 *
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- @surea11y/core's own deliberate "not a
 * violations-only list" design (see ../core/docs/OUTPUT_SCHEMA.md).
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
 * `.withCustomRules([...])` (@surea11y/core's `engineOptions.customRules`
 * escape hatch -- see ../core/docs/ENGINE_OPTIONS.md). Pass a real,
 * live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * @surea11y/core needs on this side of the page.evaluate() JSON boundary for
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
   * Runs the scan and returns @surea11y/core's native result object.
   *
   * Rejects with an `EngineError` (from @surea11y/binding-base) carrying
   * the engine's `code` when the engine refuses the input:
   * `INVALID_RUN_ONLY` when none of the rule IDs, or none of the tags, given
   * to withRules()/withTags() is one it knows, and
   * `INVALID_CONTEXT_SELECTOR` (with `selector`) for an include() selector
   * the browser can't parse.
   * @returns {Promise<object>} see ../core/docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const { contextSelector, engineOptions, runOnly } = this._buildEngineArgs();
    // The script that registers withPacks()'s packs in a frame, which the
    // scan names in engineOptions.packs; null without packs.
    const packScript = this._packScript();

    // A Playwright Page and a Frame both expose the same .evaluate(fn, arg)
    // and .url() shape, so this works unchanged for either.
    const runInFrame = async (frameOrPage, frameContextSelector) => {
      const frameUrl = this._url || (typeof frameOrPage.url === 'function' ? frameOrPage.url() : null);
      if (packScript) await frameOrPage.evaluate(packScript);
      const result = rethrowEngineError(await frameOrPage.evaluate(scanInPage, {
        url: frameUrl,
        contextSelector: frameContextSelector,
        engineOptions,
        runOnly
      }));
      this._warnScanGaps(result);
      return this._elementRef ? this._attachElementRefs(frameOrPage, result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await runInFrame(this._page, contextSelector));
    }

    const mainFrame = this._page.mainFrame();
    const topFrame = this._applyReportOnly(await runInFrame(mainFrame, contextSelector));

    // page.frames() includes the main frame itself -- exclude it here since
    // it's already covered by topFrame above, so callers don't have to
    // de-duplicate it themselves out of the frames array.
    const subFrames = this._page.frames().filter((f) => f !== mainFrame);
    // include() scopes the top frame only: each sub-frame is scanned whole,
    // as core's own runa11yCoreAcrossFrames does. Since @surea11y/core
    // 1.10.0 a contextSelector that matches nothing scans nothing, so
    // passing the top frame's selector on would leave out every frame that
    // doesn't happen to contain the same element (before 1.10.0 such a frame
    // was silently scanned whole). exclude() still applies in every frame.
    const frames = [];
    for (const frame of subFrames) {
      try {
        frames.push(this._applyReportOnly(await runInFrame(frame, null)));
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
   * Resolves each occurrence to a live ElementHandle, scoped to
   * frameOrPage's own document (a Playwright Page and Frame both expose the
   * same .evaluateHandle(fn, arg) shape), through its shadow hosts when it
   * has `shadowHostSelectors`. Mutates and returns the same result object
   * -- it's a fresh object from this scan, not shared external state.
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
        occurrence.elementHandle = occurrence.selector ? await this._findElement(frameOrPage, occurrence) : null;
      }
    }
    return result;
  }

  /**
   * Prints what the scan left out (getScanGaps(): an include() scope that
   * matched nothing, a custom rule that did not run) with console.warn,
   * once per scanned frame. @surea11y/core warns about these too, but in
   * the page's console, which a Playwright run does not show; a result
   * whose checksResults alone look clean would otherwise pass without a
   * word.
   */
  _warnScanGaps(result) {
    let gaps;
    try {
      gaps = getScanGaps(result);
    } catch (e) {
      return; // not a scan result; nothing to say about it here
    }
    const where = result.url ? ` (${result.url})` : '';
    for (const gap of gaps) {
      console.warn(`@surea11y/playwright${where}: ${gap.message}`);
    }
  }

  async _findElement(frameOrPage, occurrence) {
    const handle = await frameOrPage.evaluateHandle(findOccurrenceElement, {
      selector: occurrence.selector,
      shadowHostSelectors: occurrence.shadowHostSelectors || null
    });
    const element = handle.asElement();
    if (!element) await handle.dispose();
    return element;
  }
}

module.exports = { A11yCoreBuilder };
