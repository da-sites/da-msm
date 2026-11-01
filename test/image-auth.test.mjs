import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import worker from '../src/index.js';

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');

afterEach(() => {
  mock.restoreAll();
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else delete globalThis.caches;
});

function setup({ org, contentOrigin, inherited = false, cached, upstream }) {
  const env = {
    CONTENT_ORIGIN: contentOrigin,
    ADMIN_ORIGIN: 'https://admin.da.live',
  };
  const stored = [];
  const pending = [];
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, opts });
    if (url === `${env.ADMIN_ORIGIN}/config/${org}/`) {
      return Response.json({
        msm: { data: inherited ? [{ satellite: 'satellite', base: 'base' }] : [] },
      });
    }
    if (inherited && url === `${contentOrigin}/${org}/satellite/page`) {
      return new Response(null, { status: 404 });
    }
    assert.equal(url, `${contentOrigin}/${org}/${inherited ? 'base' : 'satellite'}/page`);
    return upstream.clone();
  });
  globalThis.caches = {
    default: {
      async match() { return cached?.clone(); },
      async put(request, response) { stored.push(response); },
    },
  };
  return {
    env,
    stored,
    pending,
    requests,
    ctx: { waitUntil(promise) { pending.push(promise); } },
    request: new Request(`https://worker.example/${org}/satellite/page`, {
      headers: { Authorization: 'Bearer test-token' },
    }),
  };
}

for (const host of ['content.da.live', 'stage-content.da.live']) {
  for (const inherited of [false, true]) {
    test(`${host}: image auth for ${inherited ? 'inherited' : 'local'} HTML`, async () => {
      const state = setup({
        org: `${host}-${inherited}`,
        contentOrigin: `https://${host}`,
        inherited,
        upstream: new Response('<h1>Current content</h1>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Upstream': 'preserved' },
        }),
      });
      const response = await worker.fetch(state.request, state.env, state.ctx);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-html2md-img-src'), host);
      assert.equal(response.headers.get('X-Upstream'), 'preserved');
      assert.equal(await response.text(), '<h1>Current content</h1>');
      await Promise.all(state.pending);
      assert.equal(state.stored.length, 1);
      assert.equal(state.stored[0].headers.get('x-html2md-img-src'), host);
      for (const { opts } of state.requests) {
        assert.equal(opts.headers.get('Authorization'), 'Bearer test-token');
      }
    });
  }
}

for (const previousHeader of [undefined, '*']) {
  test(`cached HTML restricts image auth to DA (previous: ${previousHeader})`, async () => {
    const state = setup({
      org: `cached-${previousHeader}`,
      contentOrigin: 'https://content.da.live',
      cached: new Response('<h1>Cached content</h1>', {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, max-age=120',
          ...(previousHeader ? { 'x-html2md-img-src': previousHeader } : {}),
        },
      }),
    });
    const response = await worker.fetch(state.request, state.env, state.ctx);
    assert.equal(response.headers.get('x-html2md-img-src'), 'content.da.live');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=120');
    assert.equal(await response.text(), '<h1>Cached content</h1>');
    assert.equal(state.requests.length, 0);
  });
}

for (const [status, contentType, cacheControl] of [
  [200, 'application/json', 'public, max-age=60'],
  [401, 'text/html', 'no-store'],
  [404, 'text/html', 'no-store'],
  [302, 'text/html', 'no-store'],
  [200, 'text/html', 'private, no-store'],
]) {
  test(`preserves ${status} ${contentType} (${cacheControl}) behavior`, async () => {
    const state = setup({
      org: `response-${status}-${contentType}-${cacheControl}`.replaceAll(/[^a-z0-9-]/g, '-'),
      contentOrigin: 'https://content.da.live',
      upstream: new Response('unchanged', {
        status,
        headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
      }),
    });
    const response = await worker.fetch(state.request, state.env, state.ctx);
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'unchanged');
    assert.equal(response.headers.get('Cache-Control'), cacheControl);
    assert.equal(
      response.headers.get('x-html2md-img-src'),
      status === 200 && contentType === 'text/html' ? 'content.da.live' : null,
    );
    await Promise.all(state.pending);
    assert.equal(state.stored.length, status === 200 && contentType === 'application/json' ? 1 : 0);
  });
}
