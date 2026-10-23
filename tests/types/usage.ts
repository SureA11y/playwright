// Compiled, not run, by tests/types.test.js: what a TypeScript user of this
// package writes, against its types as published.
import type { BrowserContext, Page } from 'playwright';
import type { ScanResult } from '@surea11y/core';
import { definePack } from '@surea11y/core/pack';
import {
  A11yCoreBuilder,
  EngineError,
  formatFailures,
  formatOccurrenceLocation,
  getScanGaps,
  getScanNotes,
  type A11yCoreResult,
  type A11yCoreMultiFrameResult,
  type CheckResult,
  type EngineErrorCode,
  type Occurrence,
  type ScanGap,
  getGatingFailures,
  SEVERITIES
} from '../../src/index';

declare const page: Page;
declare const context: BrowserContext;

async function main(): Promise<void> {
  await A11yCoreBuilder.installInternalsHook(page);
  await A11yCoreBuilder.installInternalsHook(context);
  await A11yCoreBuilder.installListenerHook(page);
  await A11yCoreBuilder.installListenerHook(context);
  await A11yCoreBuilder.installLiveRegionHook(page);
  const said = await A11yCoreBuilder.getAnnouncements(page);
  const texts: string[] = (said || []).map((a) => `${a.politeness}: ${a.text}`);
  const planned = new A11yCoreBuilder({ page }).withWcag('2.2', 'aa').wcagLevel('aa');
  const plannedIds: string[] = planned.plannedChecks().map((c) => c.ruleId).concat(planned.plannedCriteria().map((r) => r.id));
  void plannedIds;

  const results = await new A11yCoreBuilder({ page })
    .include('main')
    .exclude('.cookie-banner', { rules: ['color-contrast-minimum'] })
    .withWcag('2.2', 'AA')
    .withBestPractices()
    .includeMode('or')
    .wcagLevel('AA')
    .logger((entry, frame) => { void `${frame.url}: ${entry.kind} ${entry.message}`; })
    .withTags('best-practice')
    .disableRules('meta-refresh-no-exceptions')
    .withPacks(definePack({ name: '@acme/a11y-rules', version: '1.0.0', namespace: 'acme', core: '^1.11.1' }))
    .reportOnly(['fail', 'cantTell'])
    .elementRef(true)
    .screenshots({ dir: 'a11y-shots', outcomes: ['fail', 'cantTell'], padding: 8, highlight: true, max: 20 })
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
      const shot = o.screenshot;
      if (shot && 'path' in shot) String(shot.path + shot.box.width);
      else if (shot && 'buffer' in shot) shot.buffer.toString('base64');
      else if (shot) String(shot.skipped + (shot.error ?? ''));
    }
  }

  // The binding's result stays assignable to core's own result type.
  const asCore: ScanResult = result;

  const message: string = formatFailures(result.checksResults, { outcomes: ['fail'] });
  const whole: string = formatFailures(result);
  const gaps: ScanGap[] = getScanGaps(result);
  for (const note of getScanNotes(result)) {
    if (note.kind === 'internals-hook') note.elementCount.toFixed();
    else note.message.toUpperCase();
  }
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

declare const gateResult: Parameters<typeof getGatingFailures>[0];
const gatingIds: string[] = getGatingFailures(gateResult, { failOnSeverity: SEVERITIES[2] }).map((c) => c.ruleId);

declare const conditionResult: A11yCoreResult;
const seenIn: string[] = (conditionResult.checksResults[0].occurrences[0].conditions || []).concat((conditionResult.conditionRuns || []).map((r) => r.condition));
