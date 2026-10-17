'use strict';

// EN 301 549 as a pack (@surea11y/pack-en301549), with a core that no longer
// has it built in. The pack takes @surea11y/core as a peer, as this binding
// does, so the binding, binding-base and the pack load one core: the one
// whose scan the binding injects and whose packScript() registers the pack.
// Under a core with EN 301 549 built in (1.12 and earlier, as the Compat
// workflow installs from npm) the page skips the pack, so the scans are
// skipped there.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');
const en301549 = require('@surea11y/pack-en301549');
const { A11yCoreBuilder, getScanGaps } = require('../src/index.js');

const coreFrom = (dir) => require.resolve('@surea11y/core', { paths: [dir] });
const dirOf = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));

let builtIn = false;
try {
  require.resolve('@surea11y/core/en301549');
  builtIn = true;
} catch {
  // The core this binding loads has no EN 301 549 of its own.
}
const skip = builtIn && 'the installed @surea11y/core has EN 301 549 built in, and skips the pack';

const PAGE =
  'data:text/html,<!doctype html><html lang="en"><head><title>Home</title></head><body><main>' +
  '<h1>Library</h1><img src="logo.png"><a href="/x"></a><p>Text</p></main></body></html>';

async function scan(configure) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(PAGE);
    return await configure(new A11yCoreBuilder({ page })).analyze();
  } finally {
    await browser.close();
  }
}

test('the binding, binding-base and the pack load one @surea11y/core', () => {
  const core = coreFrom(path.join(__dirname, '..', 'src'));
  assert.strictEqual(coreFrom(dirOf('@surea11y/binding-base')), core);
  assert.strictEqual(coreFrom(dirOf('@surea11y/pack-en301549')), core);
});

test('withPacks(en301549) with the en301549-v4.1.1 profile reports its clauses, and no gap', { skip }, async () => {
  const results = await scan((b) => b.withPacks(en301549).options({ profile: 'en301549-v4.1.1' }));
  assert.deepStrictEqual(results.engine.packs, [`${en301549.name}@${en301549.version}`]);
  assert.strictEqual(results.engine.profile, 'en301549-v4.1.1');
  assert.strictEqual(results.skippedPacks, undefined, JSON.stringify(results.skippedPacks));
  assert.deepStrictEqual(getScanGaps(results), []);
  const ids = results.rulesResults.map((r) => r.ruleId);
  assert.ok(ids.includes('en301549-V4.1.1-9.1.1.1'), ids.join(', '));
  assert.deepStrictEqual(ids.filter((id) => !id.startsWith('en301549-V4.1.1-')), []);
  assert.strictEqual(results.rulesResults.find((r) => r.ruleId === 'en301549-V4.1.1-9.1.1.1').outcome, 'fail');
});

test('withPacks(en301549) with the en301549-v3.2.1 profile reports its clauses, 9.4.1.1 included', { skip }, async () => {
  const results = await scan((b) => b.withPacks(en301549).options({ profile: 'en301549-v3.2.1' }));
  assert.strictEqual(results.skippedPacks, undefined, JSON.stringify(results.skippedPacks));
  assert.deepStrictEqual(getScanGaps(results), []);
  const ids = results.rulesResults.map((r) => r.ruleId);
  assert.ok(ids.includes('en301549-V3.2.1-9.4.1.1'), ids.join(', '));
  assert.deepStrictEqual(ids.filter((id) => !id.startsWith('en301549-V3.2.1-')), []);
});

test("withPacks(en301549) with mappings: ['en301549'] names the clauses on a WCAG scan", { skip }, async () => {
  const results = await scan((b) => b.withPacks(en301549).withWcag('2.2').options({ mappings: ['en301549'] }));
  assert.strictEqual(results.skippedPacks, undefined, JSON.stringify(results.skippedPacks));
  assert.deepStrictEqual(getScanGaps(results), []);
  const img = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  const clauses = img.meta.normativeMappings.filter((m) => m.standard === 'EN 301 549').map((m) => `${m.version} ${m.requirement}`);
  assert.ok(clauses.includes('V4.1.1 9.1.1.1'), JSON.stringify(img.meta.normativeMappings));
});
