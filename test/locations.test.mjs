import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const contentOrigin = 'https://content.example';
const adminOrigin = 'https://admin.example';
let orgSeq = 0;

/**
 * Runs one request against the worker with a fake DA.
 * sites: { [site]: { locations?: rows, msm?: (org-level rows) } }
 * pages: { 'site/path': body }   index: { 'site/locPath': indexJson }
 */
async function run(t, {
  sites = {}, msm, pages = {}, index = {}, path,
}) {
  orgSeq += 1;
  const org = `loc-${orgSeq}`;
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
  const authSeen = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push(url);
    authSeen.push(new Headers(opts?.headers).get('authorization'));
    const notFound = () => new Response('Not found', { status: 404 });
    if (url === `${adminOrigin}/config/${org}/`) {
      return msm ? Response.json({ msm: { data: msm } }) : notFound();
    }
    const cfg = url.match(new RegExp(`^${adminOrigin}/config/${org}/([^/]+)$`));
    if (cfg) {
      const rows = sites[cfg[1]]?.locations;
      return rows ? Response.json({ locations: { data: rows } }) : notFound();
    }
    const idx = url.match(new RegExp(`^${adminOrigin}/source/${org}/([^/]+)/\\.da/loc(.*)/index\\.json$`));
    if (idx) {
      const json = index[`${idx[1]}${idx[2] || '/'}`];
      return json ? Response.json(json) : notFound();
    }
    const content = url.match(new RegExp(`^${contentOrigin}/${org}/(.*)$`));
    if (content && pages[content[1]] !== undefined) {
      const body = pages[content[1]];
      return typeof body === 'string' ? new Response(body) : Response.json(body);
    }
    return notFound();
  });

  const pending = [];
  const response = await worker.fetch(
    new Request(`https://worker.example/${org}${path}`, { headers: { authorization: 'Bearer tok' } }),
    { ADMIN_ORIGIN: adminOrigin, CONTENT_ORIGIN: contentOrigin },
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  const contentRequests = requests
    .filter((u) => u.startsWith(contentOrigin))
    .map((u) => u.slice(`${contentOrigin}/${org}/`.length));
  return {
    response, requests, contentRequests, authSeen,
  };
}

const gamebox = {
  locations: [
    { Path: '/global', Language: 'en', Label: 'Global', Level: '0', Source: '', Actions: '', 'Missing Pages': 'none' },
    { Path: '/en-us', Language: 'en-US', Source: '/global', Actions: 'link, rollout', missing_pages: 'linked' },
    { Path: '/fr', Source: '/global', Actions: 'link, translate', MissingPages: 'linked' },
    { Path: '/fr-be', Source: '/fr', Actions: 'link', MissingPages: 'linked' },
    { Path: '/de', Source: '/global', Actions: 'translate', MissingPages: 'none' },
  ],
};
const retail = {
  locations: [
    { path: '/bestbuy', source: 'gamebox:/en-us', missingPages: 'linked' },
  ],
};

test('folder-level same-site inheritance: gamebox /en-us → /global', async (t) => {
  const { response, contentRequests, authSeen } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/products/x': 'global x' },
    path: '/gamebox/en-us/products/x',
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'global x');
  assert.deepEqual(contentRequests, ['gamebox/en-us/products/x', 'gamebox/global/products/x']);
  assert(authSeen.every((a) => a === 'Bearer tok'));
});

test('multi-hop same-site: /fr-be → /fr → /global', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/products/x': 'global x' },
    path: '/gamebox/fr-be/products/x',
  });
  assert.equal(await response.text(), 'global x');
  assert.deepEqual(contentRequests, [
    'gamebox/fr-be/products/x', 'gamebox/fr/products/x', 'gamebox/global/products/x',
  ]);
});

test('own content wins without resolution', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/en-us/products/x': 'en-us x', 'gamebox/global/products/x': 'global x' },
    path: '/gamebox/en-us/products/x',
  });
  assert.equal(await response.text(), 'en-us x');
  assert.deepEqual(contentRequests, ['gamebox/en-us/products/x']);
});

test('cross-site: retail /bestbuy → gamebox /en-us → /global', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: { gamebox, retail },
    pages: { 'gamebox/global/products/x': 'global x' },
    path: '/retail/bestbuy/products/x',
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'global x');
  assert.deepEqual(contentRequests, [
    'retail/bestbuy/products/x', 'gamebox/en-us/products/x', 'gamebox/global/products/x',
  ]);
});

test('cross-site stops at intermediate override', async (t) => {
  const { response } = await run(t, {
    sites: { gamebox, retail },
    pages: { 'gamebox/en-us/products/x': 'en-us x', 'gamebox/global/products/x': 'global x' },
    path: '/retail/bestbuy/products/x',
  });
  assert.equal(await response.text(), 'en-us x');
});

test('`none` location stops resolution (404)', async (t) => {
  const { response, contentRequests, requests } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/products/x': 'global x' },
    path: '/gamebox/de/products/x',
  });
  assert.equal(response.status, 404);
  assert.deepEqual(contentRequests, ['gamebox/de/products/x']);
  assert(requests.some((u) => u.endsWith('/gamebox/.da/loc/de/index.json')));
});

test('pending linked overrides `none`', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/products/x': 'global x' },
    index: { 'gamebox/de': { pending: { '/de/products/x': { linked: true } } } },
    path: '/gamebox/de/products/x',
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'global x');
  assert.deepEqual(contentRequests, ['gamebox/de/products/x', 'gamebox/global/products/x']);
});

test('pending entry without linked does not resolve', async (t) => {
  const { response } = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/products/x': 'global x' },
    index: { 'gamebox/de': { pending: { '/de/products/x': { linked: false } } } },
    path: '/gamebox/de/products/x',
  });
  assert.equal(response.status, 404);
});

test('page outside any location and dot paths are not resolved', async (t) => {
  const a = await run(t, {
    sites: { gamebox },
    pages: { 'gamebox/global/about': 'x' },
    path: '/gamebox/about',
  });
  assert.equal(a.response.status, 404);
  const b = await run(t, {
    sites: { site: { locations: [{ path: '/', source: 'base:/', missingPages: 'linked' }] } },
    pages: { 'base/.helix/x': 'x', 'base/about': 'base about' },
    path: '/site/.helix/x',
  });
  assert.equal(b.response.status, 404);
  assert.deepEqual(b.contentRequests, ['site/.helix/x']);
});

test('whole-site `/` location maps path as-is', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: { site: { locations: [{ path: '/', source: 'base', missingPages: 'linked' }] } },
    pages: { 'base/about': 'base about' },
    path: '/site/about',
  });
  assert.equal(await response.text(), 'base about');
  assert.deepEqual(contentRequests, ['site/about', 'base/about']);
});

test('cycle safety', async (t) => {
  const { response, contentRequests } = await run(t, {
    sites: {
      a: { locations: [{ path: '/x', source: 'b:/y', missingPages: 'linked' }] },
      b: { locations: [{ path: '/y', source: 'a:/x', missingPages: 'linked' }] },
    },
    path: '/a/x/page',
  });
  assert.equal(response.status, 404);
  assert.deepEqual(contentRequests, ['a/x/page', 'b/y/page']);
});

test('depth is capped at 5 hops', async (t) => {
  const locations = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ path: `/l${i}`, source: `/l${i + 1}`, missingPages: 'linked' }));
  const { response, contentRequests } = await run(t, {
    sites: { s: { locations } },
    pages: { 's/l8/p': 'deep' },
    path: '/s/l1/p',
  });
  assert.equal(response.status, 404);
  assert.equal(contentRequests.length, 6);
});

test('legacy msm sheet used when site has no locations sheet', async (t) => {
  const { response, contentRequests, requests } = await run(t, {
    msm: [{ base: 'base-site', satellite: 'satellite' }],
    pages: { 'base-site/page': 'base page' },
    path: '/satellite/page',
  });
  assert.equal(await response.text(), 'base page');
  assert.deepEqual(contentRequests, ['satellite/page', 'base-site/page']);
  assert(requests.includes(`${adminOrigin}/config/${requests[0].split('/')[4]}/`));
});

test('locations sheet takes precedence over legacy msm sheet', async (t) => {
  const { response, contentRequests } = await run(t, {
    msm: [{ base: 'other', satellite: 'gamebox' }],
    sites: { gamebox },
    pages: { 'other/de/p': 'legacy', 'gamebox/global/p': 'global' },
    path: '/gamebox/de/p',
  });
  assert.equal(response.status, 404);
  assert.deepEqual(contentRequests, ['gamebox/de/p']);
});

test('redirects merge across distinct sites of a location chain (closer wins)', async (t) => {
  const { response } = await run(t, {
    sites: { gamebox, retail },
    pages: {
      'gamebox/redirects.json': { data: [{ Source: '/a', Destination: '/g-a' }, { Source: '/b', Destination: '/g-b' }] },
      'retail/redirects.json': { data: [{ Source: '/a', Destination: '/r-a' }] },
    },
    path: '/retail/redirects.json',
  });
  const json = await response.json();
  assert.deepEqual(json.data, [
    { Source: '/a', Destination: '/r-a' },
    { Source: '/b', Destination: '/g-b' },
  ]);
});
