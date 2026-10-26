'use strict';

// A style sheet from another origin, which the page can't read: the binding
// fetches it from Node and core reads it, so css-orientation-lock finds the
// lock in it instead of asking. Two local servers on two ports are two
// origins; the sheet's server sends no CORS header, so the page itself can't
// fetch it either. Needs @surea11y/binding-base 1.6.0 and @surea11y/core
// 1.14.0; skipped with older ones.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { chromium } = require('playwright');
const { A11yCoreBuilder } = require('../src/index.js');

const LOCK = '@media (orientation: portrait) { body { transform: rotate(90deg); } }';

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('a style sheet from another origin is fetched and read', async (t) => {
  const cdn = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end(LOCK);
  });
  const cssUrl = `http://127.0.0.1:${cdn.address().port}/site.css`;
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="${cssUrl}"></head><body><main><p>Content</p></main></body></html>`);
  });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    cdn.close();
    site.close();
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
  await page.goto(`http://127.0.0.1:${site.address().port}/`);

  const lock = (r) => r.checksResults.find((c) => c.ruleId === 'css-orientation-lock');
  const fetched = await new A11yCoreBuilder({ page }).withRules('css-orientation-lock').analyze();
  assert.strictEqual(lock(fetched).outcome, 'fail');

  const notFetched = await new A11yCoreBuilder({ page })
    .withRules('css-orientation-lock')
    .fetchStyleSheets(false)
    .analyze();
  assert.strictEqual(lock(notFetched).outcome, 'cantTell');
});
