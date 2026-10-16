'use strict';

// .screenshots() in real browsers: Chromium, Firefox and WebKit, which
// Playwright drives each its own way (what crosses evaluate(), and how a
// clipped screenshot is taken). Each picture is
// checked by its pixels: the element's own colour where the element is.
// The page and its cross-origin frame are served from two local ports, so
// nothing here depends on the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const playwright = require('playwright');
const { decodePng } = require('@surea11y/binding-base/src/png.js');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');

// A transparent image, so each <img> shows its own background colour.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const PAGE = (child) => `<!doctype html><html lang="en"><head><title>Shots</title><style>
  body { margin: 0; font: 16px sans-serif }
  header { position: sticky; top: 0; background: #036; color: #fff; padding: 20px; z-index: 5 }
  #scroller { height: 120px; overflow: auto; border: 1px solid }
</style></head><body>
<header>Header</header>
<main>
  <h1>Shots</h1>
  <img id="top" src="${GIF}" width="80" height="40" style="background:rgb(255,165,0)">
  <p style="height:1200px">spacer</p>
  <div id="scroller"><p style="height:400px">inner</p><img id="inner" src="${GIF}" width="50" height="30" style="background:rgb(0,128,0)"></div>
  <x-card></x-card>
  <img id="hidden" src="${GIF}" style="display:none">
  <div style="position:absolute;left:-9999px"><img id="away" src="${GIF}" width="10" height="10"></div>
  <iframe id="child" title="Child" src="${child}" width="400" height="300" style="border:10px solid #ccc;padding:5px"></iframe>
  <p style="height:800px">after</p>
</main>
<script>
  customElements.define('x-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<img src="${GIF}" width="60" height="60" style="background:rgb(128,0,128)">'; }
  });
</script>
</body></html>`;

const CHILD = `<!doctype html><html lang="en"><head><title>Child</title></head><body style="margin:0">
<main><h1>Child</h1><p style="height:500px">child spacer</p>
<img id="framed" src="${GIF}" width="70" height="35" style="background:rgb(0,128,128)"></main>
</body></html>`;

// The colour each flagged image is, by where core says it is.
const COLOURS = {
  '#top': [255, 165, 0],
  '#inner': [0, 128, 0],
  'html > body > main > x-card >>> img': [128, 0, 128],
  '#framed': [0, 128, 128]
};

function serve(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(body());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The page on localhost, its frame on 127.0.0.1: two origins.
async function servePages() {
  const child = await serve(() => CHILD);
  const childUrl = `http://127.0.0.1:${child.address().port}/`;
  const page = await serve(() => PAGE(childUrl));
  return {
    url: `http://localhost:${page.address().port}/`,
    close: () => { child.close(); page.close(); }
  };
}

function where(occurrence) {
  return (occurrence.shadowHostSelectors || []).concat(occurrence.selector).join(' >>> ');
}

// The colour at the middle of the element in its picture.
function colourAt(png, box, scale) {
  const x = Math.floor((box.x + box.width / 2) * scale);
  const y = Math.floor((box.y + box.height / 2) * scale);
  return Array.from(png.rows.subarray(y * png.stride + x * png.bpp, y * png.stride + x * png.bpp + 3));
}

function assertColour(png, box, scale, want, label) {
  const got = colourAt(png, box, scale);
  assert.ok(want.every((v, i) => Math.abs(v - got[i]) <= 3), `${label}: ${got} at the element, wanted ${want}`);
}

// What the page looks like from outside: scroll positions and markup.
function pageState(page) {
  return page.evaluate(() => [window.scrollX, window.scrollY, document.getElementById('scroller').scrollTop, document.documentElement.outerHTML]);
}

for (const browserName of ['chromium', 'firefox', 'webkit']) {
  test(`screenshots(): pictures each flagged element in its own colour, says why for the rest, and leaves the page as it was (${browserName})`, async () => {
    const pages = await servePages();
    const browser = await playwright[browserName].launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
      await page.goto(pages.url, { waitUntil: 'load' });
      await page.evaluate(() => { window.scrollTo(0, 37); document.getElementById('scroller').scrollTop = 11; });
      const before = await pageState(page);

      // Core reports no finding on what CSS hides, so a rule of the test's
      // own flags #hidden, to be pictured as not-rendered.
      const results = await new A11yCoreBuilder({ page })
        .withCustomRules({
          id: 'test-flags-hidden',
          meta: { title: 'Flags #hidden', tags: ['test'] },
          runInPage(ctx) {
            const el = ctx.document.getElementById('hidden');
            return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
          }
        })
        .withRules(['img-alt-present', 'test-flags-hidden'])
        .screenshots({ padding: 8 })
        .frames(true)
        .analyze();

      const top = results.topFrame.checksResults.find((c) => c.ruleId === 'img-alt-present');
      const found = new Map(top.occurrences.map((o) => [where(o), o]));
      const byWhere = { get: (name) => found.get(name) || assert.fail(`${name} is not among the findings: ${[...found.keys()].join(', ')}`) };
      for (const name of ['#top', '#inner', 'html > body > main > x-card >>> img']) {
        const shot = byWhere.get(name).screenshot;
        assert.ok(shot && shot.buffer, `${name}: ${JSON.stringify(shot)}`);
        const png = decodePng(shot.buffer);
        // The picture is the element plus 8px around it, at twice the CSS pixels.
        assert.strictEqual(png.width % 2, 0);
        assertColour(png, shot.box, 2, COLOURS[name], name);
      }
      const hidden = results.topFrame.checksResults.find((c) => c.ruleId === 'test-flags-hidden').occurrences[0];
      assert.deepStrictEqual(hidden.screenshot, { skipped: 'not-rendered' });
      assert.deepStrictEqual(byWhere.get('#away').screenshot, { skipped: 'off-screen' });

      // The image in the cross-origin frame, placed on the top-level page.
      assert.strictEqual(results.frames.length, 1);
      const framed = results.frames[0].checksResults.find((c) => c.ruleId === 'img-alt-present').occurrences[0];
      assert.ok(framed.screenshot.buffer, JSON.stringify(framed.screenshot));
      assertColour(decodePng(framed.screenshot.buffer), framed.screenshot.box, 2, COLOURS['#framed'], '#framed');

      assert.deepStrictEqual(await pageState(page), before);
      assert.deepStrictEqual(await page.evaluate(() => Object.getOwnPropertySymbols(window).map(String)), []);
    } finally {
      await browser.close();
      pages.close();
    }
  });
}

test('screenshots({ dir }): one file per element, named after it, which formatFailures() points to; reportOnly() and elementRef() still apply', async () => {
  const pages = await servePages();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surea11y-playwright-shots-'));
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(pages.url, { waitUntil: 'load' });

    const run = () => new A11yCoreBuilder({ page })
      .withRules(['img-alt-present', 'image-alt-not-filename'])
      .screenshots({ dir })
      .reportOnly(['fail'])
      .elementRef(true)
      .analyze();
    const results = await run();

    const [check] = results.checksResults;
    const occurrence = check.occurrences.find((o) => o.selector === '#top');
    assert.ok(occurrence.elementHandle, 'elementRef() still attaches its handle');
    assert.match(occurrence.screenshot.path, /element-[0-9a-f]{8}\.png$/);
    assert.strictEqual(path.dirname(occurrence.screenshot.path), dir);
    assert.ok(decodePng(fs.readFileSync(occurrence.screenshot.path)));
    assert.ok(formatFailures(results).includes(`   screenshot: ${occurrence.screenshot.path}`));
    const files = fs.readdirSync(dir).sort();

    // The same elements get the same files on the next run.
    const again = await run();
    assert.strictEqual(again.checksResults[0].occurrences.find((o) => o.selector === '#top').screenshot.path, occurrence.screenshot.path);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), files);
  } finally {
    await browser.close();
    pages.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots(): max caps the pictures a scan takes, frames included', async () => {
  const pages = await servePages();
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pages.url, { waitUntil: 'load' });
    const results = await new A11yCoreBuilder({ page }).withRules('img-alt-present').screenshots({ max: 2 }).frames(true).analyze();
    const shots = [results.topFrame, ...results.frames]
      .flatMap((r) => r.checksResults[0].occurrences)
      .map((o) => o.screenshot);
    assert.strictEqual(shots.filter((s) => s.buffer).length, 2);
    assert.ok(shots.some((s) => s.skipped === 'max-reached'));
  } finally {
    await browser.close();
    pages.close();
  }
});

test('screenshots(): off unless asked; with selectors turned off, analyze() rejects before scanning', async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`data:text/html,<html><body><img src="${GIF}"></body></html>`);
    const plain = await new A11yCoreBuilder({ page }).withRules('img-alt-present').analyze();
    assert.ok(!('screenshot' in plain.checksResults[0].occurrences[0]));

    await assert.rejects(
      new A11yCoreBuilder({ page }).options({ output: { includeSelector: false } }).screenshots().analyze(),
      (e) => e instanceof TypeError && e.code === 'INVALID_ENGINE_OPTIONS'
    );
    assert.throws(() => new A11yCoreBuilder({ page }).screenshots({ padding: -1 }), (e) => e.code === 'INVALID_ENGINE_OPTIONS');
  } finally {
    await browser.close();
  }
});
