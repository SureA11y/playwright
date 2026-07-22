'use strict';

/**
 * Minimal runnable example: scans a real page with a real (headless)
 * browser and prints every rule outcome that failed.
 *
 * Run: npm run example -- https://example.com/
 *      (defaults to https://example.com/ if no URL is given)
 */

const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('../src/index.js');

async function main() {
  const url = process.argv[2] || 'https://example.com/';

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const results = await new A11yCoreBuilder({ page }).analyze();

    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    console.log(`Scanned ${url}`);
    console.log(`${results.checksResults.length} rules evaluated, ${fails.length} failed.\n`);

    for (const f of fails) {
      console.log(`${f.ruleId} (${f.severity}): ${f.occurrences.length} occurrence(s)`);
      for (const occ of f.occurrences.slice(0, 3)) {
        console.log(`  - ${occ.selector}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
