const CONFIG_TTL = 5 * 60 * 1000;
const configCache = new Map();
const MERGE_PATH_RE = /^\/(redirects)(\.json)?$/;

async function getMsmBase(org, site, headers, env) {
  const cached = configCache.get(org);
  if (cached && Date.now() - cached.ts < CONFIG_TTL) {
    return cached.mapping.get(site) || null;
  }

  const configUrl = `${env.ADMIN_ORIGIN}/config/${org}/`;
  const resp = await fetch(configUrl, { headers });
  if (!resp.ok) return null;

  const config = await resp.json();
  const msmData = config?.msm?.data;
  const mapping = new Map();
  if (msmData) {
    for (const row of msmData) {
      if (row.satellite) mapping.set(row.satellite, row.base);
    }
  }
  configCache.set(org, { mapping, ts: Date.now() });

  return mapping.get(site) || null;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const queryString = search ? `?${search}` : '';

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

    if (MERGE_PATH_RE.test(restOfPath)) {
      const base = await getMsmBase(org, site, headers, env);
      if (base) {
        const satelliteUrl = `${env.CONTENT_ORIGIN}/${org}/${site}${restOfPath}${queryString}`;
        const baseUrl = `${env.CONTENT_ORIGIN}/${org}/${base}${restOfPath}${queryString}`;

        const [satelliteJson, baseJson] = await Promise.all([
          fetchJson(satelliteUrl, fetchOpts),
          fetchJson(baseUrl, fetchOpts),
        ]);

        const merged = mergeSheetJson(baseJson, satelliteJson);
        if (merged) {
          return new Response(JSON.stringify(merged), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    const satelliteUrl = `${env.CONTENT_ORIGIN}/${org}/${site}${restOfPath}${queryString}`;
    const satelliteResponse = await fetch(satelliteUrl, fetchOpts);

    if (satelliteResponse.status === 404) {
      const base = await getMsmBase(org, site, headers, env);
      if (base) {
        const baseUrl = `${env.CONTENT_ORIGIN}/${org}/${base}${restOfPath}${queryString}`;
        return fetch(baseUrl, fetchOpts);
      }
    }

    return satelliteResponse;
  },
};
