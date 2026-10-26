'use strict';

const core = require('@surea11y/core');

const { runa11yCoreInPage, internalsHookScript } = core;
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement
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
 * Or let the scan take a picture of each element it flags, with
 * `.screenshots()` (@surea11y/binding-base's, see its README): each
 * occurrence gets a `screenshot` field, the picture (a Buffer, or a file in
 * `dir`) or why there is none. The element is scrolled into view and marked
 * with a box drawn over the page, and the page is put back afterwards; in
 * every frame with `.frames(true)`, including cross-origin ones:
 *
 * const results = await new A11yCoreBuilder({ page })
 *   .screenshots({ dir: 'a11y-shots', padding: 16 })
 *   .analyze();
 * // results.checksResults[i].occurrences[j].screenshot
 * //   -> { path: 'a11y-shots/element-3f9a1c07.png', box: { x, y, width, height } }
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
 * reportOnly()/frames()/elementRef()/screenshots() are the exception: each
 * call replaces the previous value rather than merging with it.
 */
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * Installs @surea11y/core's opt-in internals hook, so a scan can read the
   * names, states and roles web components set through a private
   * ElementInternals. Takes a Page, or a BrowserContext to cover every page
   * it opens. Call it before page.goto(): Playwright runs init scripts
   * before the page's own scripts in every frame, and again after each
   * navigation (addInitScript()). The page already loaded when it is called
   * doesn't get it until it navigates. Resolves when the script is added.
   * @param {import('playwright').Page | import('playwright').BrowserContext} pageOrContext
   */
  static installInternalsHook(pageOrContext) {
    if (!pageOrContext || typeof pageOrContext.addInitScript !== 'function') {
      throw new TypeError('A11yCoreBuilder.installInternalsHook() requires a Playwright Page or BrowserContext (with an .addInitScript() method).');
    }
    return pageOrContext.addInitScript({ content: internalsHookScript() });
  }

  /**
   * Installs @surea11y/core's opt-in listener hook, so the keyboard rules
   * see the event listeners the page adds from script (`addEventListener`,
   * `el.onclick = fn`), which no page script can list. Without it a
   * `<div role="button">` given a click listener from script goes
   * unjudged. Takes a Page, or a BrowserContext to cover every page it
   * opens. Call it before page.goto(), as installInternalsHook(). Needs
   * @surea11y/core 1.14.0 or later. Resolves when the script is added.
   * @param {import('playwright').Page | import('playwright').BrowserContext} pageOrContext
   */
  static installListenerHook(pageOrContext) {
    return installHook(pageOrContext, 'installListenerHook', 'listenerHookScript');
  }

  /**
   * Installs @surea11y/core's opt-in live-region hook, which records what
   * the page's live regions are given while it runs: the scan then asks
   * about a region added with its text already in it, and
   * A11yCoreBuilder.announcements(page) returns what the page made
   * available to announce. Takes a Page, or a BrowserContext to cover every
   * page it opens. Call it before page.goto(), as installInternalsHook().
   * Needs @surea11y/core 1.14.0 or later.
   * @param {import('playwright').Page | import('playwright').BrowserContext} pageOrContext
   */
  static installLiveRegionHook(pageOrContext) {
    return installHook(pageOrContext, 'installLiveRegionHook', 'liveRegionHookScript');
  }

  /**
   * What `page`'s live regions were given since it loaded, as the
   * live-region hook recorded it, in order: `[{ text, politeness, time,
   * order, behindModal, selector }]`, each region named by its selector (and
   * `shadowHostSelectors` inside a shadow root; null for a region that has
   * since left the page). null where installLiveRegionHook() wasn't called
   * before the page loaded. What the page made available to announce, not
   * what a screen reader said. A text given to a region behind an open
   * modal dialog, which assistive technology did not get, is listed only
   * with `{ includeBehindModal: true }`, marked `behindModal`. Needs
   * @surea11y/core 1.14.0 or later.
   * @param {import('playwright').Page} page
   * @param {{ includeBehindModal?: boolean }} [options]
   * @returns {Promise<Array<object>|null>}
   */
  static announcements(page, options) {
    return new A11yCoreBuilder({ page })._announcementsIn(page, options);
  }

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
      // The text of the style sheets the frame can't read, fetched from Node
      // (binding-base 1.6.0 and core 1.14.0; nothing with older ones).
      const frameEngineOptions =
        typeof this._styleSheetEngineOptions === 'function'
          ? await this._styleSheetEngineOptions(frameOrPage, engineOptions)
          : engineOptions;
      const result = rethrowEngineError(await frameOrPage.evaluate(scanInPage, {
        url: frameUrl,
        contextSelector: frameContextSelector,
        engineOptions: frameEngineOptions,
        runOnly
      }));
      this._warnScanGaps(result, '@surea11y/playwright');
      // Right after the frame's scan, before reportOnly(): nothing unless
      // .screenshots() was called.
      if (this._screenshots) await this._screenshotFrame(frameOrPage, result);
      return this._elementRef ? this._attachElementRefs(frameOrPage, result) : result;
    };

    // .conditions() (binding-base 1.6.0): the page as it is, then under each
    // condition, merged into one result.
    if (this._conditions) {
      return this._applyReportOnly(
        await this._scanUnderConditions(() => runInFrame(this._page, contextSelector), this._conditionDriver())
      );
    }

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
   * The driver steps .conditions() scans need: the viewport's width with
   * page.setViewportSize() (its height kept) and the color scheme with
   * page.emulateMedia(). Each condition sets both, from the page as it was,
   * so one condition's width or scheme doesn't carry into the next; at the
   * end the viewport goes back, and if a condition set a scheme, the page
   * is left in the scheme it had before (a scheme emulated by the caller, or
   * the system's). The scheme is set back by name, not cleared with null:
   * WebKit keeps a dark emulation that null should clear.
   */
  _conditionDriver() {
    const page = this._page;
    let schemeSet = false;
    let viewport = null;
    // The scheme a condition without one goes back to.
    let baseScheme = 'light';
    return {
      save: async () => {
        const before = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dark: matchMedia('(prefers-color-scheme: dark)').matches
        }));
        viewport = page.viewportSize() || { width: before.width, height: before.height };
        baseScheme = before.dark ? 'dark' : 'light';
        return { viewport };
      },
      apply: async (condition) => {
        await page.setViewportSize({ width: condition.width || viewport.width, height: viewport.height });
        if (condition.colorScheme) {
          await page.emulateMedia({ colorScheme: condition.colorScheme });
          schemeSet = true;
        } else if (schemeSet) {
          await page.emulateMedia({ colorScheme: baseScheme });
          schemeSet = false;
        }
      },
      restore: async (state) => {
        if (!state) return;
        await page.setViewportSize(state.viewport);
        if (schemeSet) await page.emulateMedia({ colorScheme: baseScheme });
      }
    };
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
   * binding-base's screenshots step for one scanned frame (or the page),
   * with the <iframe>s leading to it: each frame's frameElement(), a handle
   * in its parent, disposed afterwards.
   */
  async _screenshotFrame(frameOrPage, result) {
    const framePath = [];
    const parentOf = (f) => (typeof f.parentFrame === 'function' ? f.parentFrame() : null);
    for (let f = frameOrPage; parentOf(f); f = parentOf(f)) {
      // null when the frame detached after its scan: binding-base fails
      // that frame's pictures.
      const iframe = await f.frameElement().catch(() => null);
      framePath.unshift({ frame: parentOf(f), iframe });
    }
    try {
      await this._captureScreenshots(result, frameOrPage, framePath);
    } finally {
      await Promise.all(framePath.map((step) => (step.iframe ? step.iframe.dispose().catch(() => {}) : null)));
    }
  }

  /**
   * For binding-base's screenshots step: runs `fn(...args)` in the frame.
   * Playwright's evaluate() takes one argument, so the arguments go as one
   * array (an element handle inside it arrives as the element) and are
   * spread in the page.
   */
  /**
   * For binding-base's style sheet step: fetch with the page's own request
   * API, which carries its cookies, in the shape of fetch().
   */
  get _styleSheetFetch() {
    const request = this._page && typeof this._page.request === 'object' ? this._page.request : null;
    if (!request || typeof request.get !== 'function') return null;
    return async (url) => {
      const res = await request.get(url, { timeout: 5000 });
      return { ok: res.ok(), text: () => res.text() };
    };
  }

  _evaluateInFrame(frameOrPage, fn, args) {
    // eslint-disable-next-line no-new-func
    return frameOrPage.evaluate(new Function('args', 'return (' + fn.toString() + ')(...args)'), args);
  }

  /**
   * For binding-base's screenshots step: a PNG of `box`, CSS pixels in the
   * viewport, which is what Playwright's clip is relative to.
   */
  _captureBox(box) {
    return this._page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
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

// One of core's hook scripts (1.14.0 and later for the listener and
// live-region hooks), added as an init script, which runs before the page's
// own scripts.
function installHook(pageOrContext, method, scriptName) {
  if (!pageOrContext || typeof pageOrContext.addInitScript !== 'function') {
    throw new TypeError(`A11yCoreBuilder.${method}() requires a Playwright Page or BrowserContext (with an .addInitScript() method).`);
  }
  if (typeof core[scriptName] !== 'function') {
    throw new Error(`A11yCoreBuilder.${method}() needs @surea11y/core 1.14.0 or later, which has ${scriptName}().`);
  }
  return pageOrContext.addInitScript({ content: core[scriptName]() });
}

module.exports = { A11yCoreBuilder };
