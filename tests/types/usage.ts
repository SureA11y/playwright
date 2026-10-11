// Compiled, not run, by tests/types.test.js: what a TypeScript user of this
// package writes, against its types as published.
import type { Page } from 'playwright';
import type { ScanResult } from '@surea11y/core';
import { definePack } from '@surea11y/core/pack';
import {
  A11yCoreBuilder,
  EngineError,
  formatFailures,
  formatOccurrenceLocation,
  getScanGaps,
  type A11yCoreResult,
  type A11yCoreMultiFrameResult,
  type CheckResult,
  type EngineErrorCode,
  type Occurrence,
  type ScanGap
} from '../../src/index';

declare const page: Page;

async function main(): Promise<void> {
  const results = await new A11yCoreBuilder({ page })
    .include('main')
    .exclude('.cookie-banner', { rules: ['color-contrast-minimum'] })
    .withWcag('2.2', 'AA')
    .withBestPractices()
    .withTags('best-practice')
    .disableRules('meta-refresh-no-exceptions')
    .withPacks(definePack({ name: '@acme/a11y-rules', version: '1.0.0', namespace: 'acme', core: '^1.11.1' }))
    .reportOnly(['fail', 'cantTell'])
    .elementRef(true)
    .analyze();

  if ('topFrame' in results) {
    const multi: A11yCoreMultiFrameResult = results;
    for (const frame of multi.frames) {
      if ('error' in frame) {
        const reason: string = frame.error;
      } else {
        const checks: CheckResult[] = frame.checksResults;
      }
    }
    return;
  }

  const result: A11yCoreResult = results;
  const version: string = result.engine.version;
  const layout: boolean = result.engine.environment.layout;
  const scanned: number | undefined = result.contextMatch?.elementCount;
  const unmatched: string[] | undefined = result.contextMatch?.unmatchedSelectors;
  const skipped: Array<{ id: string | null; reason: string }> = result.skippedCustomRules;

  for (const check of result.checksResults) {
    const headroom: number | undefined = check.margin?.headroom;
    const deprecated: boolean = check.meta.deprecated;
    for (const occurrence of check.occurrences) {
      const o: Occurrence = occurrence;
      const hosts: string[] | undefined = o.shadowHostSelectors;
      const path: number[] | null = o.structuralPath;
      const where: string = formatOccurrenceLocation(o);
      if (o.elementHandle) await o.elementHandle.screenshot();
    }
  }

  // The binding's result stays assignable to core's own result type.
  const asCore: ScanResult = result;

  const message: string = formatFailures(result.checksResults, { outcomes: ['fail'] });
  const whole: string = formatFailures(result);
  const gaps: ScanGap[] = getScanGaps(result);
  for (const gap of gaps) {
    if (gap.kind === 'custom-rule-skipped') {
      const id: string | null = gap.rule.id;
    } else if (gap.kind === 'pack-skipped') {
      const name: string | null = gap.pack.name;
    } else {
      const selectors: string[] = gap.selectors;
    }
  }

  try {
    await new A11yCoreBuilder({ page }).withRules(['img-alt-present']).analyze();
  } catch (e) {
    if (e instanceof EngineError) {
      const code: EngineErrorCode | (string & {}) = e.code;
      const selector: string | null = e.selector;
    }
  }
}

main();
