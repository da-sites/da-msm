const CONFIG_TTL = 5 * 60 * 1000;
const MAX_INHERITANCE_DEPTH = 6;
const RESOLVED_CACHE_TTL = 5 * 60;
const configCache = new Map();
const MERGE_PATH_RE = /^\/(redirects)(\.json)?$/;

async function getMsmMapping(org, headers, env) {
  const cached = configCache.get(org);
  if (cached && Date.now() - cached.ts < CONFIG_TTL) {
    return cached.mapping;
  }

  const configUrl = `${env.ADMIN_ORIGIN}/config/${org}/`;
  const resp = await fetch(configUrl, { headers });
  if (!resp.ok) return new Map();

  const config = await resp.json();
  const msmData = config?.msm?.data;
  const mapping = new Map();
  if (msmData) {
    for (const row of msmData) {
      if (row.satellite) mapping.set(row.satellite, row.base);
    }
  }
  configCache.set(org, { mapping, ts: Date.now() });

  return mapping;
}

function getAncestorChain(mapping, site) {
  const chain = [];
  const visited = new Set();
  let current = site;

  while (chain.length < MAX_INHERITANCE_DEPTH) {
    const base = mapping.get(current);
    if (!base) break;
    if (visited.has(base)) break; // cycle detected
    visited.add(base);
    chain.push(base);
    current = base;
  }

  return chain;
}

async function fetchJson(url, opts) {
  const resp = await fetch(url, opts);
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function mergeRows(baseRows, satelliteRows) {
  if (!baseRows?.length) return satelliteRows || [];
  if (!satelliteRows?.length) return baseRows || [];

  const keyProp = Object.keys(baseRows[0])[0];
  const merged = new Map();
  for (const row of baseRows) merged.set(row[keyProp], row);
  for (const row of satelliteRows) merged.set(row[keyProp], row);
  return [...merged.values()];
}

function mergeSheetJson(baseJson, satelliteJson) {
  if (!baseJson) return satelliteJson;
  if (!satelliteJson) return baseJson;

  const data = mergeRows(baseJson.data, satelliteJson.data);
  return { ...baseJson, total: data.length, limit: data.length, offset: 0, data };
}

function isCacheable(request, response) {
  if (request.method !== 'GET') return false;
  if (!response.ok) return false;
  if (response.headers.has('Set-Cookie')) return false;
  const cc = response.headers.get('Cache-Control') || '';
  if (cc.includes('no-store') || cc.includes('private')) return false;
  return true;
}

function withDefaultCacheControl(response) {
  const headers = new Headers(response.headers);
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', `public, max-age=${RESOLVED_CACHE_TTL}`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function maybeCache(ctx, cache, request, response) {
  if (!isCacheable(request, response)) return response;
  const cacheable = withDefaultCacheControl(response.clone());
  ctx.waitUntil(cache.put(request, cacheable));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const queryString = search ? `?${search}` : '';

    // colo-local response cache. Skips the entire walk on repeat hits.
    const cache = caches.default;
    if (request.method === 'GET') {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Parse path: /org/site/rest/of/path
    const pathParts = url.pathname.split('/').filter(Boolean);
    const org = pathParts[0];
    const site = pathParts[1];
    let restOfPath = '/' + pathParts.slice(2).join('/');
    if (url.pathname.endsWith('/') && !restOfPath.endsWith('/')) {
      restOfPath += '/';
    }

    // Clone body for potential base fallback use
    const body = request.body ? await request.arrayBuffer() : null;

    // Build headers, explicitly preserving Authorization
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      headers.set(key, value);
    }

    const fetchOpts = { method: request.method, headers, body, redirect: 'manual' };

    const mapping = await getMsmMapping(org, headers, env);
    const ancestors = getAncestorChain(mapping, site);

    if (MERGE_PATH_RE.test(restOfPath)) {
      if (ancestors.length) {
        const allSites = [site, ...ancestors];
        const results = await Promise.all(
          allSites.map((s) => fetchJson(
            `${env.CONTENT_ORIGIN}/${org}/${s}${restOfPath}${queryString}`,
            fetchOpts,
          )),
        );

        // Merge from root ancestor down so nearer overrides win
        let merged = null;
        for (let i = results.length - 1; i >= 0; i -= 1) {
          merged = mergeSheetJson(merged, results[i]);
        }
        if (merged) {
          const mergedResponse = new Response(JSON.stringify(merged), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `public, max-age=${RESOLVED_CACHE_TTL}`,
            },
          });
          return maybeCache(ctx, cache, request, mergedResponse);
        }
      }
    }

    const satelliteUrl = `${env.CONTENT_ORIGIN}/${org}/${site}${restOfPath}${queryString}`;
    const satelliteResponse = await fetch(satelliteUrl, fetchOpts);

    if (satelliteResponse.status !== 404) {
      return maybeCache(ctx, cache, request, satelliteResponse);
    }

    if (!ancestors.length) return satelliteResponse;

    const probeOpts = { method: 'GET', headers, redirect: 'manual' };
    const probeResults = await Promise.all(
      ancestors.map((ancestor) => fetch(
        `${env.CONTENT_ORIGIN}/${org}/${ancestor}${restOfPath}${queryString}`,
        probeOpts,
      ).catch(() => null)),
    );

    const winnerIdx = probeResults.findIndex((r) => r && r.ok);

    // Release upstream connections for losing probes
    probeResults.forEach((r, i) => {
      if (r && i !== winnerIdx) r.body?.cancel();
    });

    if (winnerIdx === -1) return satelliteResponse;
    return maybeCache(ctx, cache, request, probeResults[winnerIdx]);
  },
};
