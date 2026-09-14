# DA MSM - Multi-Site Management for Edge Delivery Services

A Cloudflare Worker that brings Multi-Site Management (MSM) inheritance capabilities to Adobe Edge Delivery Services, enabling content inheritance patterns similar to AEM's blueprint/livecopy architecture.

## What is Multi-Site Management (MSM)?

Multi-Site Management (MSM) is a content management pattern that allows organizations to manage multiple websites efficiently by creating relationships between a base site (aka blueprint) and satellites (aka live copies). Key benefits include:

- **Content Reuse**: Share content across multiple sites while maintaining consistency
- **Efficient Updates**: Changes to the blueprint can be rolled out to live copies
- **Selective Overrides**: Live copies can override specific content while inheriting the rest

When content is requested from a satellite that doesn't exist or has been deleted, the system inherits from its base site. A base can itself be the satellite of another base, so inheritance can chain across multiple levels (e.g. a store site inherits from a country site, which inherits from a global site).

### What makes MSM on Edge Delivery different?
- **Transparency in authoring**: Only the content that is _truly unique_ to the satellite exists in the satellite. This creates immediate clarity when browsing this content.
- **Multi-level inheritance**: Satellites can chain through multiple base levels (e.g. store → country → global), with each level able to override only what's unique to it.
- **Inherited redirects support**: Redirects from every ancestor in the chain are merged with the satellite's own redirects. Rows from a closer (more satellite-side) site take precedence over the same key from a more distant ancestor.
- **De-prioritized Localization**: Due to DA's existing and extensive localization feature-set, DA MSM is targeted at brand experience inheritance. We believe the two features are complementary.

## What This Worker Does

This Cloudflare Worker replicates the MSM inheritance behavior for Edge Delivery Services by:

1. **Intercepting content requests** in the format `/org/site/path`
2. **Attempting a satellite fetch** from the requested site location
3. **Looking up the MSM config** from the DA admin API to resolve the full chain of ancestor (base) sites
4. **Inheriting from the ancestor chain on 404**, walking up through each base in order until one resolves
5. **Merging redirects across the whole ancestor chain** (closer sites win on duplicate keys)
6. **Preserving request context** (headers, query parameters, and authentication) on the direct satellite request. The worker holds no credentials of its own — see [Authentication](#authentication).
7. **Caching resolved responses at the edge** for repeat requests (see [Response Caching](#response-caching))

### Request Flow

```
┌─────────────────────────────────────────────────────────┐
│  Edge Delivery Services Site                            │
│  (content source configured to use this worker)         │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  DA MSM Worker                                          │
│  https://da-msm.adobeaem.workers.dev                    │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Try Satellite: /acme/us-store/content/page             │
│  Status: 404                                            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼ MSM config lookup resolves the ancestor chain:
                      │   us-store → na-region → global-site
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Try Ancestor 1: /acme/na-region/content/page           │
│  Status: 404                                            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Try Ancestor 2: /acme/global-site/content/page         │
│  Status: 200 ✓                                         │
└─────────────────────────────────────────────────────────┘
```

All ancestors in the chain are probed **in parallel**, and the first ok response found (nearest to the satellite) is returned. The chain is capped at a fixed maximum depth with cycle detection, so a misconfigured loop (e.g. A → B → A) can't cause infinite lookups.

### Pointing a site at the worker

Set the worker as the site's content source through the configuration service (per [Adobe's MSM documentation](https://docs.da.live/about/early-access/multi-site-manager)):

```json
PUT https://admin.hlx.page/config/{org}/sites/{site}.json

"content": {
  "source": {
    "type": "markup",
    "url": "https://da-msm.your-domain.workers.dev/{org}/{site}/"
  }
}
```

A site's content source is immutable once bound — an in-place `PUT` returns
`409`, so moving an existing site means `DELETE` then `PUT`, which mints a new
`contentBusId` and empties the content bus. Re-publish afterwards.

> Older setups mounted the worker with an `fstab.yaml` mountpoint
> (`mountpoints: { /: https://…/acme/store-1 }`). That still appears in some
> examples below; the configuration service above is the current route —
> `fstab.yaml` is no longer required for new sites (see the
> [FAQ](https://www.aem.live/docs/faq#what-is-fstabyaml)).

### MSM Config Setup

The base-to-satellite mapping is managed in the DA config UI at `da.live/config#/{org}/` under the **msm** tab. The sheet has three columns:

| base | satellite | title |
|---|---|---|
| global-site | | Global Site (base) |
| global-site | na-region | North America (region) |
| na-region | store-1 | Store 1 |
| na-region | store-2 | Store 2 |

- **base**: The base (blueprint) site repo name
- **satellite**: The satellite (live copy) site repo name (empty for the base entry itself)
- **title**: A human-readable label

A row's `base` can itself appear as a `satellite` in another row (as `na-region` does above), which is what forms a multi-level chain: `store-1 → na-region → global-site`. The worker walks the full chain, up to a fixed maximum depth, with cycle detection to guard against misconfigured loops.

The worker fetches this config from the DA admin API and caches it in memory (5-minute TTL).

### How It Works

1. **Author Preview Request**: An author sends a preview request to Edge Delivery for a satellite page
2. **Worker Request**: Edge Delivery requests the content from the MSM worker
3. **Satellite Content Request**: The worker requests the satellite content from DA
4. **Content Overridden**: If the content has been overridden in the satellite, this content is sent back to Edge Delivery
5. **Inherit from the Ancestor Chain**: If the content has not been overridden (satellite returns 404), the worker resolves the satellite's full ancestor chain from the MSM config and probes every ancestor in parallel, returning content from the nearest ancestor that resolves

> Inheritance resolves when **admin fetches the content**, not at delivery. An
> inherited page still needs its own `preview` / `live` call on the satellite
> before visitors can see it — publishing a base page does not publish it across
> satellites on its own. With many satellites, that is one call per satellite per
> path.

### Authentication

The worker holds no credentials. It copies the incoming request's headers
through to `CONTENT_ORIGIN` and `ADMIN_ORIGIN`, so **DA sees whatever the caller
sent** — and DA is not anonymously readable, so a request that arrives without
credentials comes back `401`.

When the AEM admin fetches content on your behalf, it does **not** forward the
`Authorization` header you sent it. That header authenticates you *to admin*.
Admin forwards **`x-content-source-authorization`**, and presents it to the
content source as `Authorization`.

So every `preview` / `live` call against a site behind this worker needs both:

```bash
curl -X POST "https://admin.hlx.page/preview/{org}/{site}/main/{path}" \
  -H "authorization: Bearer $TOKEN" \
  -H "x-content-source-authorization: Bearer $TOKEN"
```

```js
const headers = {
  authorization: `Bearer ${TOKEN}`,                    // authenticates you to admin
  'x-content-source-authorization': `Bearer ${TOKEN}`, // forwarded to the content source
};
```

Sending both is harmless for a site that sits directly on `content.da.live`, so
there is no need to branch on whether the worker is in the path.

#### Troubleshooting

If preview or publish returns `401` and the error names the worker:

```
[admin] Unable to fetch '/some/path.md' from 'html2md': (401) -
not authenticated to access resource: https://da-msm.…workers.dev/{org}/{site}/some/path
```

…the credential never reached the worker. Add
`x-content-source-authorization`. The worker is behaving correctly — it
forwarded what it received, which was nothing.

### Redirect Inheritance

When a request targets a redirect resource (`/redirects` or `/redirects.json`), the worker merges redirects across the satellite and its entire ancestor chain rather than using 404 fallback:

1. Redirects for the satellite and every ancestor in its chain are fetched **in parallel**
2. Rows are merged using the first column (the source URL) as the key, starting from the most distant ancestor and applying nearer sites on top
3. Where the same key exists at multiple levels, the row from the site **closest to the satellite wins**
4. The merged result is returned as a single JSON response

```
┌───────────────────────────────────────────────────────────┐
│  global-site redirects (/acme/global-site/redirects)      │
│  /old-about  →  /about                                    │
│  /old-help   →  /help                                     │
│  /old-legal  →  /legal                                    │
└──────────────────────┬────────────────────────────────────┘
                       │  merge (most distant ancestor first)
                       ▼
┌───────────────────────────────────────────────────────────┐
│  na-region redirects (/acme/na-region/redirects)          │
│  /old-help   →  /na/help              ← overrides global  │
└──────────────────────┬────────────────────────────────────┘
                       │  merge (nearer ancestor wins on conflict)
                       ▼
┌───────────────────────────────────────────────────────────┐
│  store-1 redirects (/acme/store-1/redirects)              │
│  /old-about  →  /store-1/about        ← overrides global  │
│  /promo      →  /store-1/sale         ← satellite-only    │
└──────────────────────┬────────────────────────────────────┘
                       │  satellite wins on conflict
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Merged result                                            │
│  /old-about  →  /store-1/about        (satellite)         │
│  /old-help   →  /na/help              (na-region)         │
│  /old-legal  →  /legal                (global-site)        │
│  /promo      →  /store-1/sale         (satellite)         │
└───────────────────────────────────────────────────────────┘
```

If a site in the chain has no redirects, it's simply skipped in the merge; if none of them do, an empty result is returned.

## Usage

### URL Structure

```
https://da-msm.your-domain.workers.dev/{org}/{site}/{path}
```

**Parameters:**
- `org`: Your organization identifier (e.g., "acme")
- `site`: The satellite site to fetch from (e.g., "us-site")
- `path`: The content path being requested

The ancestor chain (base, base-of-base, etc.) is resolved automatically from the org's MSM config.

## Use Cases

### 1. Brand Hierarchy

Sub-brands can inherit content from parent brands:

```yaml
mountpoints:
  /: https://da-msm.worker.dev/acme/subbrand
```

### 2. Staging/Production Inheritance

Development sites can inherit production content:

```yaml
mountpoints:
  /: https://da-msm.worker.dev/acme/dev
```

## Response Caching

In addition to the in-memory MSM config cache, the worker uses Cloudflare's colo-local Cache API (`caches.default`) to cache resolved responses for repeat `GET` requests:

- On a `GET` request, the worker first checks the cache and returns a hit immediately, skipping the satellite fetch, ancestor probing, and any merging entirely.
- A response is only cached if it's a `GET`, the upstream response was successful (`response.ok`), and the response has no `Set-Cookie` header and no `Cache-Control: no-store` or `Cache-Control: private` directive.
- Cached (and merged-redirect) responses are stored with `Cache-Control: public, max-age=300` (5 minutes) if the upstream didn't already set its own `Cache-Control`.

This means a change to content, redirects, or the MSM config itself may take up to 5 minutes to be reflected in a given Cloudflare colo, even though the in-memory MSM config cache is refreshed independently.

## Environments

The worker supports multiple environments via Wrangler, each targeting a different DA content and admin origin.

| Environment | Content Origin | Admin Origin | Worker Name |
|---|---|---|---|
| Production (default) | `content.da.live` | `admin.da.live` | `da-msm` |
| Stage | `stage-content.da.live` | `stage-admin.da.live` | `da-msm-stage` |

Configuration in `wrangler.toml`:

```toml
[vars]
CONTENT_ORIGIN = "https://content.da.live"
ADMIN_ORIGIN = "https://admin.da.live"

[env.stage.vars]
CONTENT_ORIGIN = "https://stage-content.da.live"
ADMIN_ORIGIN = "https://stage-admin.da.live"
```

Each environment deploys as a separate worker with its own `workers.dev` endpoint, so your site's content source configuration (`fstab.yaml` or the Configuration Service API) can point to the appropriate one.

## Development

### Local Development

```bash
# Install dependencies
npm install

# Start local development server
npm run dev

# Test the worker locally
curl "http://localhost:8787/acme/us-site/content/test"
```

### Deployment

```bash
# Deploy production worker
npm run deploy

# Deploy stage worker
npm run deploy:stage
```

After deployment, the endpoints will be:
- **Production**: `https://da-msm.your-domain.workers.dev`
- **Stage**: `https://da-msm-stage.your-domain.workers.dev`
