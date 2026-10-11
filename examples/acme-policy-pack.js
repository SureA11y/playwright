'use strict';

// A small pack: one house rule, a checklist profile and two checklist items.
// A real pack is a package of its own; `npx surea11y-pack new <folder>` writes one.

const { definePack, wcagTags } = require('@surea11y/core/pack');

module.exports = definePack({
  name: '@acme/a11y-policy',
  title: 'Acme web policy',
  version: '1.0.0',
  namespace: 'acme',
  core: '^1.11.1',
  rules: [
    {
      id: 'acme-no-autoplay',
      meta: {
        title: 'Videos do not play sound on their own',
        description: 'A video that starts with sound talks over a screen reader.',
        tags: ['acme'],
        defaultSeverity: 'serious'
      },
      runInPage(ctx) {
        // defaultMuted reflects the muted attribute where muted isn't set from it yet (jsdom).
        const loud = [...ctx.document.querySelectorAll('video[autoplay]')].filter((v) => !(v.muted || v.defaultMuted));
        return loud.length
          ? {
              outcome: 'fail',
              occurrences: loud.map((v) =>
                ctx.helpers.reportOccurrence(v, { summary: 'This video plays with sound as the page opens.', hint: 'Remove autoplay, or add muted.' })
              )
            }
          : { outcome: 'pass', occurrences: [] };
      }
    }
  ],
  profiles: {
    'acme-web-2026': { tags: wcagTags('2.2', ['A', 'AA']), rules: ['region', 'acme-no-autoplay'] }
  },
  rollups: [
    { id: 'acme-images', title: 'Images have a text alternative', checksIds: ['img-alt-present'] },
    { id: 'acme-media', title: 'Media stays quiet until asked', checksIds: ['acme-no-autoplay'] }
  ]
});
