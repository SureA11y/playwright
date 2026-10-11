'use strict';

/**
 * Scans a page against a pack's checklist (see acme-policy-pack.js) and
 * prints each checklist item's result, then any finding.
 *
 * Run: npm run example:pack -- https://example.com/
 *      (defaults to a small built-in page if no URL is given)
 */

const { chromium } = require('playwright');
const { A11yCoreBuilder, formatFailures, getScanGaps } = require('../src/index.js');
const acmePolicy = require('./acme-policy-pack.js');

const SAMPLE =
  'data:text/html,<html lang="en"><head><title>Acme</title></head><body><main>' +
  '<h1>Launch</h1><img src="hero.png"><video src="intro.mp4" autoplay></video></main></body></html>';

async function main() {
  const url = process.argv[2] || SAMPLE;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const results = await new A11yCoreBuilder({ page })
      .withPacks(acmePolicy)
      .options({ profile: 'acme-web-2026' })
      .analyze();

    console.log(`Scanned with ${results.engine.packs.join(', ')}, profile ${results.engine.profile}\n`);
    for (const item of results.rulesResults.filter((r) => r.meta && r.meta.standard === 'Acme web policy')) {
      console.log(`${item.outcome.padEnd(13)} ${item.title}`);
    }
    console.log('\n' + formatFailures(results, { outcomes: ['fail'] }));

    // A pack the page didn't run (its core range, or a page on another core)
    // is a gap, not a pass.
    if (getScanGaps(results).length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
