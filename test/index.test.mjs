import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const cases = [
  {
    name: 'inherits using base/satellite columns',
    rows: [{ base: 'base-site', satellite: 'satellite' }],
    ancestors: ['base-site'],
  },
  {
    name: 'inherits using source/linked columns',
    rows: [
      { source: 'base-site', linked: '', title: 'Base' },
      { source: 'base-site', linked: 'satellite' },
    ],
    ancestors: ['base-site'],
  },
  {
    name: 'inherits across mixed naming schemes',
    rows: [
      { source: 'regional', linked: 'satellite' },
      { base: 'global', satellite: 'regional' },
    ],
    ancestors: ['regional', 'global'],
  },
  {
    name: 'prefers legacy columns when both names are present',
    rows: [{
      base: 'base-site',
      satellite: 'satellite',
      source: 'other-base',
      linked: 'other-satellite',
    }],
    ancestors: ['base-site'],
  },
  {
    name: 'falls back from null legacy columns',
    rows: [{
      base: null,
      satellite: null,
      source: 'base-site',
      linked: 'satellite',
    }],
    ancestors: ['base-site'],
  },
  {
    name: 'preserves empty legacy columns instead of falling back',
    rows: [{
      base: 'base-site',
      satellite: '',
      source: 'other-base',
      linked: 'satellite',
    }],
    ancestors: [],
  },
];

for (const [index, { name, rows, ancestors }] of cases.entries()) {
  test(name, async (t) => {
    const org = `test-${index}`;
    const contentOrigin = 'https://content.example';
    const adminOrigin = 'https://admin.example';
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => {} } },
    });
    t.after(() => {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
      else delete globalThis.caches;
    });

    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      requests.push(url);
      if (url === `${adminOrigin}/config/${org}/`) {
        return Response.json({ msm: { data: rows } });
      }
      if (url === `${contentOrigin}/${org}/satellite/page`) {
        return new Response('Not found', { status: 404 });
      }
      assert(ancestors.some((site) => url === `${contentOrigin}/${org}/${site}/page`));
      return new Response(`Content from ${new URL(url).pathname.split('/')[2]}`);
    });

    const pending = [];
    const response = await worker.fetch(
      new Request(`https://worker.example/${org}/satellite/page`),
      { ADMIN_ORIGIN: adminOrigin, CONTENT_ORIGIN: contentOrigin },
      { waitUntil: (promise) => pending.push(promise) },
    );

    assert.equal(response.status, ancestors.length ? 200 : 404);
    assert.equal(await response.text(), ancestors.length ? `Content from ${ancestors[0]}` : 'Not found');
    assert.deepEqual(requests, [
      `${adminOrigin}/config/${org}/`,
      `${contentOrigin}/${org}/satellite/page`,
      ...ancestors.map((site) => `${contentOrigin}/${org}/${site}/page`),
    ]);
    await Promise.all(pending);
  });
}
