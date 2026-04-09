# DA MSM - Multi-Site Management for Edge Delivery Services

A Cloudflare Worker that brings Multi-Site Management (MSM) inheritance capabilities to Adobe Edge Delivery Services, enabling content inheritance patterns similar to AEM's blueprint/livecopy architecture.

## What is Multi-Site Management (MSM)?

Multi-Site Management (MSM) is a content management pattern that allows organizations to manage multiple websites efficiently by creating relationships between a base site (aka blueprint) and satellites (aka live copies). Key benefits include:

- **Content Reuse**: Share content across multiple sites while maintaining consistency
- **Efficient Updates**: Changes to the blueprint can be rolled out to live copies
- **Selective Overrides**: Live copies can override specific content while inheriting the rest

When content is requested from a satellite that doesn't exist or has been deleted, the system inherits from the base site.

### What makes MSM on Edge Delivery different?
- **Tranparency in authoring**: Only the content that is _truly unique_ to the satellite exists in the satelite. This creates immediately clarity when browsing this content.
- **Inherited metadata support**: Base Metadata is seamlessly stitched together with satelite Metadata. Satellite rows take precedence.
- **De-prioritized Localization**: Due to DA's existing and extensive localization feature-set, DA MSM is targeted at brand experience inheritance. We believe the two features are complimentary.

## What This Worker Does

This Cloudflare Worker replicates the MSM inheritance behavior for Edge Delivery Services by:

1. **Intercepting content requests** in the format `/org/site/path`
2. **Attempting a satellite fetch** from the requested site location
3. **Looking up the MSM config** from the DA admin API to resolve the base site
4. **Inheriting from the base site on 404**
5. **Preserving all request context** including headers, query parameters, and authentication
6. **Stitching satelite metadata with base metadata**

### Request Flow

```
┌─────────────────────────────────────────────────────────┐
│  Edge Delivery Services Site                            │
│  (fstab.yaml configured to use this worker)             │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  DA MSM Worker                                          │
│  https://da-msm.adobedev.workers.dev                    │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Try Satellite: /acme/us-site/content/page              │
│  Status: 404                                            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼ MSM config lookup: us-site → global-site
┌─────────────────────────────────────────────────────────┐
│  Try Base: /acme/global-site/content/page               │
│  Status: 200 ✓                                          │
└─────────────────────────────────────────────────────────┘
```

### Example mountpoint

```yaml
mountpoints:
  /: https://da-msm.your-domain.workers.dev/acme/store-1
```

### MSM Config Setup

The base-to-satellite mapping is managed in the DA config UI at `da.live/config#/{org}/` under the **msm** tab. The sheet has three columns:

| base | satellite | title |
|---|---|---|
| global-site | | Global Site (base) |
| global-site | store-1 | Store 1 |
| global-site | store-2 | Store 2 |

- **base**: The base (blueprint) site repo name
- **satellite**: The satellite (live copy) site repo name (empty for the base entry itself)
- **title**: A human-readable label

The worker fetches this config from the DA admin API and caches it in memory (5-minute TTL).

### How It Works

1. **Author Preview Request**: An author sends a preview request to Edge Delivery for a satellite page
2. **Worker Request**: Edge Delivery requests the content from the MSM worker
3. **Satellite Content Request**: The worker requests the satellite content from DA
4. **Content Overridden**: If the content has been overridden in the satellite, this content is sent back to Edge Delivery
5. **Inherit from Base**: If the content has not been overridden, the worker looks up the MSM config for the satellite's base site and inherits content from there

## Usage

### URL Structure

```
https://da-msm.your-domain.workers.dev/{org}/{site}/{path}
```

**Parameters:**
- `org`: Your organization identifier (e.g., "acme")
- `site`: The satellite site to fetch from (e.g., "us-site")
- `path`: The content path being requested

The base site is resolved automatically from the org's MSM config.

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

Each environment deploys as a separate worker with its own `workers.dev` endpoint, so your site's `fstab.yaml` can point to the appropriate one.

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
