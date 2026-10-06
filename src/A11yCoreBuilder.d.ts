import type { Page, ElementHandle } from 'playwright';
import type * as Core from '@surea11y/core';

// The result shapes are @surea11y/core's own types (shipped with it since
// 1.9.0, and checked there against real scan results), so they follow the
// engine instead of a copy of its docs. This file only adds what the
// binding puts on top: `elementHandle` on an occurrence with
// .elementRef(true), and the { topFrame, frames } shape of .frames(true).
// Every name this file exported before is still exported.

import type {
  Outcome,
  OutcomeNormalized,
  Severity,
  Confidence,
  RuleType,
  LocaleResolution,
  RenderingEnvironment,
  EngineInfo,
  NormativeMapping,
  VisibilityFilter,
  Uncertainty,
  UncertaintyCode,
  Margin,
  MarginDeclaration,
  ContextMatch,
  CompositeResult
} from '@surea11y/core';

export type {
  Outcome,
  OutcomeNormalized,
  Severity,
  Confidence,
  RuleType,
  LocaleResolution,
  RenderingEnvironment,
  EngineInfo,
  NormativeMapping,
  VisibilityFilter,
  Uncertainty,
  UncertaintyCode,
  Margin,
  MarginDeclaration,
  ContextMatch,
  CompositeResult
};

/**
 * What analyze() rejects with when @surea11y/core refuses its input, with
 * the engine's `code`: `INVALID_RUN_ONLY` (withRules()/withTags() named no
 * rule or tag it knows) or `INVALID_CONTEXT_SELECTOR` (an include()
 * selector the browser can't parse; `selector` names it).
 */
export { EngineError } from '@surea11y/binding-base';
export type { EngineErrorCode } from '@surea11y/binding-base';

export type Category = Core.RuleMeta['category'];
export type LocaleResolutionReason = Core.LocaleResolution['reason'];
export type CheckResultMeta = Core.RuleMeta;
export type CompositeResultDetails = Core.CompositeResult['data']['details'];

export interface Occurrence extends Core.Occurrence {
  /**
   * Only present when `.elementRef(true)` was used. `null` when this
   * occurrence has no single resolvable target element (e.g. `selector` was
   * `""`, or a shadow host on the way is gone) -- see A11yCoreBuilder#elementRef.
   */
  elementHandle?: ElementHandle | null;
}

export interface CheckResult extends Omit<Core.CheckResult, 'occurrences'> {
  occurrences: Occurrence[];
}

/** surea11y's native top-level result shape -- see docs/OUTPUT_SCHEMA.md. */
export interface A11yCoreResult extends Omit<Core.ScanResult, 'checksResults'> {
  checksResults: CheckResult[];
}

/** A sub-frame that couldn't be scanned (detached, navigated away, or sandboxed). */
export interface A11yCoreFrameError {
  url: string | null;
  error: string;
}

/** Returned by analyze() when .frames(true) is enabled, instead of a single A11yCoreResult. */
export interface A11yCoreMultiFrameResult {
  topFrame: A11yCoreResult;
  frames: Array<A11yCoreResult | A11yCoreFrameError>;
}

/**
 * A runtime-registered rule descriptor for `.withCustomRules()` -- the same
 * shape as an internal surea11y rule module's own export (see surea11y's
 * docs/ENGINE_OPTIONS.md). `runInPage`/`applicability` may be passed as
 * either a real function or a function-source string -- `.withCustomRules()`
 * converts a live function to its source string for you, since it must
 * cross a page.evaluate() JSON boundary that cannot carry a live Function
 * reference.
 */
export interface CustomRuleDescriptor {
  id: string;
  meta?: {
    title?: string;
    description?: string;
    tags?: string[];
    defaultSeverity?: Severity;
    defaultConfidence?: Confidence;
    [key: string]: unknown;
  };
  runInPage: ((ctx: unknown) => unknown) | string;
  applicability?: ((ctx: unknown) => boolean) | string;
  data?: Record<string, unknown>;
}

export class A11yCoreBuilder {
  /**
   * @param opts.page A Playwright Page, already navigated to and settled at
   *   the URL to scan -- this class does not navigate for you.
   */
  constructor(opts: { page: Page; url?: string });

  /** Scope the scan to one region. Call multiple times for a multi-region union. */
  include(selector: string): this;
  /**
   * Skip elements matching this selector anywhere in the scanned scope.
   * With `opts.rules`, scopes the exclusion to just the named rule ID(s)
   * instead of globally -- on top of, not instead of, any global exclusions
   * from other `.exclude(selector)` calls.
   */
  exclude(selector: string, opts?: { rules?: string | string[] }): this;
  /** Only run rules carrying at least one of these tags. */
  withTags(tags: string | string[]): this;
  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags: string | string[]): this;
  /** Only run these specific rule IDs (accepts with or without the  prefix). */
  withRules(ruleIds: string | string[]): this;
  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds: string | string[]): this;
  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...). */
  options(partialEngineOptions: Record<string, unknown>): this;
  /** Register one or more custom rules for just this scan. Call multiple times to accumulate. */
  withCustomRules(rules: CustomRuleDescriptor | CustomRuleDescriptor[]): this;
  /** Post-filter checksResults down to only the given outcomes. */
  reportOnly(outcomes: Outcome | Outcome[]): this;
  /** Opt in to also scanning every sub-frame on the page (including cross-origin iframes). */
  frames(enabled?: boolean): this;
  /** Opt in to resolving each fail/cantTell occurrence's selector to a live ElementHandle. */
  elementRef(enabled?: boolean): this;

  /**
   * Runs the scan. Returns { topFrame, frames } instead of a single result
   * when .frames(true) was used. Rejects with an EngineError when the engine
   * refuses the rule/tag lists or an include() selector.
   */
  analyze(): Promise<A11yCoreResult | A11yCoreMultiFrameResult>;
}

/**
 * Formats a checksResults array into a short, human-readable block -- one
 * entry per occurrence, not per rule. Meant for an assertion library's
 * failure-message parameter, e.g.
 * `expect(results.checksResults, formatFailures(results.checksResults)).toEqual([])`.
 * Deliberately framework-agnostic -- no dependency on any particular
 * `expect` implementation.
 */
export function formatFailures(checksResults: CheckResult[], opts?: { outcomes?: Outcome[] }): string;
