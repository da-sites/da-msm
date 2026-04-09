const CONFIG_TTL = 5 * 60 * 1000;
const configCache = new Map();

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const queryString = search ? `?${search}` : '';

    // Parse path: /org/site/rest/of/path
    const pathParts = url.pathname.split('/').filter(Boolean);
    const org = pathParts[0];
    const site = pathParts[1];
    const restOfPath = '/' + pathParts.slice(2).join('/');

    // Clone body for potential base fallback use
    const body = request.body ? await request.arrayBuffer() : null;

    // Build headers, explicitly preserving Authorization
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      headers.set(key, value);
    }

    const satellitePath = `/${org}/${site}${restOfPath}${queryString}`;
    const satelliteUrl = env.CONTENT_ORIGIN + satellitePath;
    const satelliteResponse = await fetch(satelliteUrl, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });

    if (satelliteResponse.status === 404) {
      const base = await getMsmBase(org, site, headers, env);
      if (base) {
        const baseUrl = `${env.CONTENT_ORIGIN}/${org}/${base}${restOfPath}${queryString}`;
        return fetch(baseUrl, {
          method: request.method,
          headers,
          body,
          redirect: 'manual',
        });
      }
    }

    return satelliteResponse;
  },
};
