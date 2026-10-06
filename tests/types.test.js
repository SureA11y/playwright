'use strict';

// src/A11yCoreBuilder.d.ts is written by hand around @surea11y/core's own
// result types. Compile a typical use of it, so a declaration that doesn't
// fit the engine's, or a field the types lose, fails here.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('the package\'s types compile against @surea11y/core\'s and Playwright\'s', () => {
  const tsc = require.resolve('typescript/bin/tsc');
  const file = path.join(__dirname, 'types', 'usage.ts');
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--lib', 'esnext,dom', '--types', 'node', file], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(String(e.stdout) + String(e.stderr));
  }
});
