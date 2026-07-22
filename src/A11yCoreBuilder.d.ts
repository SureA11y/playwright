import type { Page, ElementHandle } from 'playwright';

// See a11y-core's docs/OUTPUT_SCHEMA.md -- this file mirrors that document's
// shapes exactly (plus the elementHandle field this binding adds on top when
// .elementRef(true) is used). Keep in sync with that doc, not the other way
// around -- it's the source of truth for what the engine actually returns.

export type Outcome = 'pass' | 'fail' | 'cantTell' | 'notApplicable';
export type OutcomeNormalized = 'pass' | 'fail' | 'cantTell' | 'inapplicable';
export type Severity = 'minor' | 'moderate' | 'serious' | 'critical';
export type Confidence = 'high' | 'medium' | 'low';
export type RuleType = 'automatic' | 'manual';
export type Category = 'perceivable' | 'operable' | 'understandable' | 'robust' | null;

export interface EngineInfo {
  tag: string;
  schemaVersion: string;
}

export interface NormativeMapping {
  standard: string;
  version: string;
  requirement: string;
  title: string;
  conformanceLevel: string;
}

export interface CheckResultMeta {
  ruleId: string;
  ruleInterfaceVersion: string;
  ruleVersion: string;
  normative: boolean;
  atomic: boolean;
  category: Category;
  normativeMappings: NormativeMapping[];
  standard: string | null;
  applicability: string;
  expectation: string;
  references: string[];
  requirements: Record<string, unknown> | null;
  mappings: Record<string, unknown> | null;
}

export interface VisibilityFilter {
  targetSet: string;
  accEligible: boolean | null;
  reasons: string[];
}

export interface Occurrence {
  selector: string;
  html: string;
  structuralPath: number[] | null;
  summary: string;
  hint: string;
  i18n: { summaryKey: string; hintKey: string; params: Record<string, unknown> } | null;
  data: {
    visibilityFilter?: VisibilityFilter;
    details?: Record<string, unknown>;
  };
  /**
   * Only present when `.elementRef(true)` was used. `null` when this
   * occurrence has no single resolvable target element (e.g. `selector` was
   * `""`) -- see A11yCoreBuilder#elementRef.
   */
  elementHandle?: ElementHandle | null;
}

export interface CheckResult {
  ruleId: string;
  outcome: Outcome;
  outcomeNormalized: OutcomeNormalized;
  severity: Severity;
  confidence: Confidence;
  type: RuleType;
  occurrences: Occurrence[];
  title: string;
  description: string;
  i18n: { titleKey: string; descriptionKey: string } | null;
  meta: CheckResultMeta;
  engineOptions: Record<string, unknown>;
  schemaVersion: string;
  /** Present only if the rule threw, or the manual-fail-to-cantTell coercion fired. */
  error?: string;
}

export interface CompositeResultDetails {
  reasonCode: string;
  checksIds: string[];
  contributors: Array<{ testId: string; outcome: string; severity: string | null }>;
  metrics: {
    failCount: number;
    cantTellCount: number;
    notApplicableCount: number;
    passCount: number;
    missingCount: number;
  };
}

export interface CompositeResult {
  ruleId: string;
  outcome: Outcome;
  severity: Severity;
  confidence: Confidence;
  type: RuleType;
  title: string;
  description: string;
  meta: CheckResultMeta;
  engineOptions: Record<string, unknown>;
  schemaVersion: string;
  /** Always empty -- composites are rollups, not element-level findings. */
  occurrences: [];
  data: { details: CompositeResultDetails };
}

/** a11y-core's native top-level result shape -- see docs/OUTPUT_SCHEMA.md. */
export interface A11yCoreResult {
  engine: EngineInfo;
  url: string | null;
  title: string | null;
  timestamp: string | null;
  perfStats: Record<string, unknown> | null;
  contextSelector: string | string[] | null;
  checksResults: CheckResult[];
  rulesResults: CompositeResult[];
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

export class A11yCoreBuilder {
  /**
   * @param opts.page A Playwright Page, already navigated to and settled at
   *   the URL to scan -- this class does not navigate for you.
   */
  constructor(opts: { page: Page; url?: string });

  /** Scope the scan to one region. Call multiple times for a multi-region union. */
  include(selector: string): this;
  /** Skip elements matching this selector anywhere in the scanned scope. */
  exclude(selector: string): this;
  /** Only run rules carrying at least one of these tags. */
  withTags(tags: string | string[]): this;
  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags: string | string[]): this;
  /** Only run these specific rule IDs (accepts with or without the a11ycore- prefix). */
  withRules(ruleIds: string | string[]): this;
  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds: string | string[]): this;
  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...). */
  options(partialEngineOptions: Record<string, unknown>): this;
  /** Post-filter checksResults down to only the given outcomes. */
  reportOnly(outcomes: Outcome | Outcome[]): this;
  /** Opt in to also scanning every sub-frame on the page (including cross-origin iframes). */
  frames(enabled?: boolean): this;
  /** Opt in to resolving each fail/cantTell occurrence's selector to a live ElementHandle. */
  elementRef(enabled?: boolean): this;

  /** Runs the scan. Returns { topFrame, frames } instead of a single result when .frames(true) was used. */
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
