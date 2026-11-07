const CONFIG_TTL = 5 * 60 * 1000;
const MAX_INHERITANCE_DEPTH = 6;
const RESOLVED_CACHE_TTL = 5 * 60;
const configCache = new Map();
const MERGE_PATH_RE = /^\/(redirects)(\.json)?$/;
const MAX_LOCATION_DEPTH = 5;
const siteConfigCache = new Map();

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
      const satellite = row.satellite ?? row.linked;
      const base = row.base ?? row.source;
      if (satellite) mapping.set(satellite, base);
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

// ---- locations mode -------------------------------------------------------

const normKey = (k) => String(k).toLowerCase().replace(/[\s_-]/g, '');

function normPath(p) {
  let out = String(p || '').trim();
  if (!out.startsWith('/')) out = `/${out}`;
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

function parseSource(value, site) {
  const raw = String(value || '').trim();
  if (!raw) return { site, path: '/' };
  const idx = raw.indexOf(':');
  if (idx > 0 && !raw.startsWith('/')) {
    return { site: raw.slice(0, idx).trim(), path: normPath(raw.slice(idx + 1)) };
  }
  if (raw.startsWith('/')) return { site, path: normPath(raw) };
  return { site: raw, path: '/' };
}

function parseLocations(rows, site) {
  return rows.map((row) => {
    const r = {};
    for (const [k, v] of Object.entries(row || {})) r[normKey(k)] = v;
    if (!r.path) return null;
    return {
      path: normPath(r.path),
      source: parseSource(r.source, site),
      missingPages: String(r.missingpages || 'none').trim().toLowerCase(),
    };
  }).filter(Boolean);
}

/** Returns the site's parsed `locations` rows, or null when it has none. */
async function getSiteLocations(org, site, headers, env) {
  const key = `${org}/${site}`;
  const cached = siteConfigCache.get(key);
  if (cached && Date.now() - cached.ts < CONFIG_TTL) return cached.locations;

  const resp = await fetch(`${env.ADMIN_ORIGIN}/config/${org}/${site}`, { headers })
    .catch(() => null);
  if (!resp) return null;
  let locations = null;
  if (resp.ok) {
    const config = await resp.json().catch(() => null);
    const rows = config?.locations?.data;
    if (Array.isArray(rows) && rows.length) locations = parseLocations(rows, site);
  }
  if (resp.ok || resp.status === 404) siteConfigCache.set(key, { locations, ts: Date.now() });
  return locations;
}

/** Deepest location containing `path`; paths starting with a dot segment never match. */
function findLocation(locations, path) {
  if (/^\/\./.test(path)) return null;
  let best = null;
  for (const loc of locations) {
    const inside = loc.path === '/' || path === loc.path || path.startsWith(`${loc.path}/`);
    if (inside && (!best || loc.path.length > best.path.length)) best = loc;
  }
  return best;
}

function relativePath(loc, path) {
  return loc.path === '/' ? path : path.slice(loc.path.length);
}

function sourcePagePath(loc, path) {
  const rel = relativePath(loc, path);
  if (loc.source.path === '/') return rel || '/';
  return `${loc.source.path}${rel}`;
}

async function isPendingLinked(org, site, loc, path, headers, env) {
  const locSeg = loc.path === '/' ? '' : loc.path;
  const index = await fetchJson(
    `${env.ADMIN_ORIGIN}/source/${org}/${site}/.da/loc${locSeg}/index.json`,
    { headers },
  ).catch(() => null);
  const pending = index?.pending;
  if (!pending || typeof pending !== 'object') return false;
  const strip = (p) => p.replace(/\.(html|md|json)$/, '');
  const rel = relativePath(loc, path) || '/';
  const keys = new Set([path, strip(path), rel, strip(rel)]);
  return [...keys].some((k) => pending[k]?.linked === true);
}

/**
 * Walks the location chain for a page that 404'd in its own site.
 * Returns the first ok source response, or null.
 */
async function resolveFromLocations(org, site, path, locations, ctxArgs) {
  const { headers, env, queryString } = ctxArgs;
  const visited = new Set([`${site}:${path}`]);
  let cur = { site, path, locations };

  for (let depth = 0; depth < MAX_LOCATION_DEPTH; depth += 1) {
    if (!cur.locations) return null;
    const loc = findLocation(cur.locations, cur.path);
    if (!loc) return null;
    const linked = loc.missingPages === 'linked'
      || await isPendingLinked(org, cur.site, loc, cur.path, headers, env);
    if (!linked) return null;

    const next = { site: loc.source.site, path: sourcePagePath(loc, cur.path) };
    const key = `${next.site}:${next.path}`;
    if (visited.has(key)) return null; // cycle
    visited.add(key);

    const resp = await fetch(
      `${env.CONTENT_ORIGIN}/${org}/${next.site}${next.path}${queryString}`,
      { method: 'GET', headers, redirect: 'manual' },
    ).catch(() => null);
    if (resp?.ok) return resp;
    resp?.body?.cancel();
    if (!resp || resp.status !== 404) return null;

    next.locations = next.site === cur.site
      ? cur.locations
      : await getSiteLocations(org, next.site, headers, env);
    cur = next;
  }
  return null;
}

/** Distinct sites reachable via location sources, nearest first (site itself first). */
async function getLocationSiteChain(org, site, locations, headers, env) {
  const chain = [site];
  let frontier = [{ site, locations }];
  while (frontier.length && chain.length <= MAX_LOCATION_DEPTH) {
    const nextFrontier = [];
    for (const { locations: locs } of frontier) {
      for (const loc of locs || []) {
        const s = loc.source.site;
        if (chain.includes(s)) continue;
        chain.push(s);
        nextFrontier.push({ site: s, locations: await getSiteLocations(org, s, headers, env) });
      }
    }
    frontier = nextFrontier;
  }
  return chain.slice(0, MAX_LOCATION_DEPTH + 1);
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
    const isMergePath = MERGE_PATH_RE.test(restOfPath);

    // Locations mode: the site's own config has a `locations` sheet.
    // Otherwise fall back to the org-level `msm` sheet (site → site).
    const locations = await getSiteLocations(org, site, headers, env);

    let chainSites;
    if (locations) {
      chainSites = isMergePath
        ? await getLocationSiteChain(org, site, locations, headers, env)
        : [site];
    } else {
      const mapping = await getMsmMapping(org, headers, env);
      chainSites = [site, ...getAncestorChain(mapping, site)];
    }

    if (isMergePath && chainSites.length > 1) {
      const results = await Promise.all(
        chainSites.map((s) => fetchJson(
          `${env.CONTENT_ORIGIN}/${org}/${s}${restOfPath}${queryString}`,
          fetchOpts,
        ).catch(() => null)),
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

    const satelliteUrl = `${env.CONTENT_ORIGIN}/${org}/${site}${restOfPath}${queryString}`;
    const satelliteResponse = await fetch(satelliteUrl, fetchOpts);

    if (satelliteResponse.status !== 404) {
      return maybeCache(ctx, cache, request, satelliteResponse);
    }

    if (locations) {
      const resolved = await resolveFromLocations(
        org,
        site,
        restOfPath,
        locations,
        { headers, env, queryString },
      );
      if (!resolved) return satelliteResponse;
      return maybeCache(ctx, cache, request, resolved);
    }

    const ancestors = chainSites.slice(1);
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
