'use strict';

const { runa11yCoreInPage } = require('a11y-core');

// See a11y-core's docs/OUTPUT_SCHEMA.md -- the only valid `outcome` values a
// checksResults entry can carry.
const VALID_OUTCOMES = ['pass', 'fail', 'cantTell', 'notApplicable'];

// a11y-core revives a customRules runInPage/applicability STRING back into a
// function via `new Function('return (' + value + ')')()` (see its
// src/core/dom-runner.js) -- the exact same mechanism used here, in Node,
// purely to verify a candidate string will actually reconstruct before it
// ever crosses the page.evaluate() boundary.
function canReconstructAsFunction(src) {
  try {
    // eslint-disable-next-line no-new-func
    return typeof new Function('return (' + src + ')')() === 'function';
  } catch (e) {
    return false;
  }
}

// Converts a live function to a source string a11y-core can revive on the
// page side. Function.prototype.toString() on an ES6 method-shorthand
// property (e.g. `{ runInPage(ctx) { ... } }`, the idiomatic way to write
// one of these descriptors, including `async`/generator variants) omits the
// `function` keyword entirely -- so the *exact same* revival mechanism
// a11y-core uses can't parse it back as a standalone expression. Verified
// with `canReconstructAsFunction` above (real check, not a regex guess at
// the syntax) and patched by re-adding `function ` when needed.
function toReconstructableSource(fn) {
  const direct = fn.toString();
  if (canReconstructAsFunction(direct)) return direct;
  const patched = direct.replace(/^(async\s+)?(\*\s*)?/, '$1function ');
  if (canReconstructAsFunction(patched)) return patched;
  // Some other shape neither form can reconstruct (e.g. a computed method
  // name) -- hand back the plain toString() anyway; a11y-core's own revival
  // will skip it the same way it always has for an unreconstructable
  // descriptor, rather than this method inventing a different failure mode.
  return direct;
}

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
    this._reportOutcomes = null;
    this._elementRef = false;
    this._customRules = [];
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
   * Register one or more custom rules for just this scan (a11y-core's
   * engineOptions.customRules escape hatch -- see a11y-core's
   * docs/ENGINE_OPTIONS.md -- axe's configure({ rules }) equivalent). A
   * descriptor is { id, meta?, runInPage, applicability?, data? }, the same
   * shape as an internal a11y-core rule module's own export. Call multiple
   * times to register several rules across one scan (accumulates, same as
   * withRules()/withTags(), rather than replacing -- see this class's own
   * header comment on mutability).
   *
   * Unlike the raw `.options({ customRules })` passthrough, `runInPage`/
   * `applicability` may be passed as real, live functions here -- this
   * method converts each to a function-source string itself, since a
   * Playwright page.evaluate() argument crosses a JSON boundary that cannot
   * carry a live Function reference (a11y-core reconstructs the string back
   * into a function via `new Function` on the page side). A string is still
   * accepted as-is for callers who already have one. Plain
   * Function.prototype.toString() isn't quite enough on its own: an ES6
   * method-shorthand property (`{ runInPage(ctx) { ... } }` -- the idiomatic
   * way to write one of these, and what every example in this file's own
   * docs/tests uses) stringifies *without* the `function` keyword, which
   * a11y-core's own `new Function('return (' + value + ')')()` revival
   * can't parse back as a standalone expression. This method verifies
   * reconstructability the same way a11y-core will and patches that specific
   * case automatically, so you don't need to know about it.
   *
   * A descriptor whose `id` collides with a built-in rule overrides it for
   * that scan only (a11y-core's own semantics, matching axe's configure()
   * override behavior) -- nothing here persists past this one analyze() call
   * or mutates a11y-core's static rule catalog.
   */
  withCustomRules(rules) {
    const list = Array.isArray(rules) ? rules : [rules];

    // Validate the whole batch before normalizing/pushing any of it, so one
    // invalid descriptor later in the array can't leave an earlier valid one
    // partially registered -- same all-or-nothing spirit as reportOnly()'s
    // own validate-then-assign shape above.
    for (const rule of list) {
      if (!rule || typeof rule.id !== 'string' || !rule.id) {
        throw new Error('A11yCoreBuilder.withCustomRules(): each custom rule descriptor requires a non-empty string `id`.');
      }
      if (typeof rule.runInPage !== 'function' && (typeof rule.runInPage !== 'string' || !rule.runInPage)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}" requires a \`runInPage\` function or function-source string.`);
      }
      if (rule.applicability !== undefined && typeof rule.applicability !== 'function' && (typeof rule.applicability !== 'string' || !rule.applicability)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}"'s \`applicability\` must be a function or function-source string when provided.`);
      }
    }

    for (const rule of list) {
      const normalized = {
        ...rule,
        runInPage: typeof rule.runInPage === 'function' ? toReconstructableSource(rule.runInPage) : rule.runInPage
      };
      if (typeof rule.applicability === 'function') normalized.applicability = toReconstructableSource(rule.applicability);
      this._customRules.push(normalized);
    }
    return this;
  }

  /**
   * Post-filter `checksResults` down to only the given outcomes (e.g.
   * .reportOnly(['fail', 'cantTell']) to drop pass/notApplicable noise).
   * Binding-layer only -- a11y-core itself always computes every rule's
   * outcome; this just trims what analyze() hands back. Applied per-frame
   * when combined with .frames(true).
   */
  reportOnly(outcomes) {
    const list = Array.isArray(outcomes) ? outcomes : [outcomes];
    for (const outcome of list) {
      if (!VALID_OUTCOMES.includes(outcome)) {
        throw new Error(`A11yCoreBuilder.reportOnly(): invalid outcome "${outcome}" -- must be one of ${VALID_OUTCOMES.join(', ')}.`);
      }
    }
    this._reportOutcomes = list;
    return this;
  }

  /**
   * Opt in to resolving each fail/cantTell occurrence's `selector` to a live
   * Playwright `ElementHandle` (attached as `occurrence.elementHandle`), so
   * callers can `.click()`/`.screenshot()`/`.highlight()` the flagged
   * element directly instead of re-resolving `occurrence.selector`
   * themselves (fragile if the DOM shifted between the scan and when you
   * act on it). Default off -- resolving a handle per occurrence costs a
   * real page query, so this stays opt-in. Uses `<page-or-frame>.$()`
   * rather than `evaluateHandle` since a plain `ElementHandle` is all
   * callers need. Combines with `.frames(true)`: each frame's occurrences
   * are resolved against that frame's own document, not the top page's.
   */
  elementRef(enabled = true) {
    this._elementRef = !!enabled;
    return this;
  }

  // Note: not every occurrence resolves to one element -- a page-wide
  // finding (e.g. some manual/cantTell rules) can carry `selector: ""`, in
  // which case `occurrence.elementHandle` is `null` rather than a handle.

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
    if (this._customRules.length) {
      // Concatenated with, not replaced by, any customRules already present
      // via a raw .options({ customRules }) call, so the two ways of
      // registering a custom rule compose rather than one silently
      // clobbering the other.
      const existing = Array.isArray(this._engineOptions.customRules) ? this._engineOptions.customRules : [];
      engineOptions.customRules = existing.concat(this._customRules);
    }
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

  /** Filters a single native result object's checksResults per .reportOnly(), if set. */
  _applyReportOnly(result) {
    if (!this._reportOutcomes || !Array.isArray(result.checksResults)) return result;
    return {
      ...result,
      checksResults: result.checksResults.filter((r) => this._reportOutcomes.includes(r.outcome))
    };
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
