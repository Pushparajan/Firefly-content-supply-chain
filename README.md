# Firefly Content Supply Chain

Adobe App Builder project implementing the full Content Supply Chain: agency upload → brand review → AI rendition → DAM distribution.

## Complete Pipeline

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AGENCY / EXTERNAL STUDIO                                                │
│  uploads PSDs, AI files, video to Adobe Content Hub (Brand Portal)       │
│  with free-text metadata: season="summer", market="emea", brand="..."    │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │  New Contribution event
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  WORKFRONT FUSION  (iPaaS automation scenario)                           │
│  1. Watch module polls Content Hub every 15 min for NEW contributions    │
│  2. HTTP POST module calls → fusion-ingest App Builder action            │
│  3. Receives AEM asset path in response                                  │
│  4. Workfront module updates Document with AEM path + task status        │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │  POST /fusion-ingest (x-fusion-secret header)
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  APP BUILDER: fusion-ingest action                                       │
│  1. Validate Fusion secret                                               │
│  2. Validate required taxonomy (brand, market, assetType)  ← FAIL FAST  │
│  3. Map free-text → AEM controlled vocabulary (CQ tag paths)             │
│  4. Derive target DAM folder from taxonomy                               │
│  5. Download binary from Content Hub                                     │
│  6. AEM Direct Binary Upload (Initiate → Azure PUT → Complete)           │
│  7. Apply resolved cq:tags via Sling POST servlet                        │
│  8. Mark Content Hub contribution as PROCESSED                           │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │  Asset lands in /content/dam/campaigns/emea/summer/hero-banners/
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  WORKFRONT approval workflow                                             │
│  Creative Director reviews asset in Workfront Proof / Frame.io          │
│  On APPROVED status → Workfront fires Event Subscription webhook         │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │  POST /orchestrate (X-WF-Signature HMAC)
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  APP BUILDER: orchestrate action                                         │
│  1. Verify HMAC-SHA256 webhook signature                                 │
│  2. Resolve IMS OAuth S2S token                                          │
│  3. Fetch Creative Cloud source asset URL from Workfront                 │
│  4. Submit Firefly V3 async generation job                               │
│     └─ style_reference: brand hero image → consistent palette/mood       │
│  5. Poll Firefly job status (5 s × 60 = 5-min window)                   │
│  6. Upload N renditions to AEM via Direct Binary Upload                  │
│  7. Write AEM paths back to Workfront Document record                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
actions/
  orchestrate/index.js     ← Workfront webhook → Firefly V3 → AEM
  fusion-ingest/index.js   ← Fusion trigger → Content Hub → AEM + taxonomy
lib/
  content-hub.js           ← Content Hub (Brand Portal) API: list/download/mark
  taxonomy.js              ← Free-text → CQ tag controlled vocabulary mapping
  workfront.js             ← HMAC verification + Workfront REST API
  firefly-v3.js            ← Firefly V3 async: submit job → poll → outputs
  aem-cloud.js             ← AEM Direct Binary Upload (3-phase protocol)
  ims.js                   ← IMS OAuth Server-to-Server token resolution
manifest.yml               ← App Builder: two web actions, timeouts, env bindings
test/unit/                 ← Jest tests for all modules and actions
```

---

## Key Design Decisions

### Why Content Hub (not AEM Assets) for agency uploads?

Agencies are external — giving them AEM author access is a security and governance problem. Content Hub is a purpose-built **brand portal** with:
- Its own user management (no AEM author licences needed)
- Contribution folders that are isolated from production DAM
- A review/approval gate before assets enter AEM
- A clear `dam:contributionStatus` property (`NEW` → `PROCESSED`) that prevents double-ingestion

### Why Workfront Fusion for the Content Hub → AEM move?

Fusion is Adobe's native iPaaS layer. It handles:
- **Polling**: watches Content Hub for new contributions without requiring a webhook infrastructure on the Content Hub side
- **Orchestration**: chains Content Hub → this App Builder action → Workfront update in one visual scenario, easy for admins to modify without code changes
- **Retry/error handling**: built-in retry logic if the App Builder action returns 5xx
- **No-code extensibility**: marketing ops can add steps (Slack notifications, email alerts) without touching the Node.js code

### Taxonomy mapping (`lib/taxonomy.js`)

The core problem: agencies write `"season": "summer"`, AEM needs `/content/cq:tags/brand/seasons/summer`.

```
Agency free-text (Content Hub)   →   AEM CQ tag path (controlled vocabulary)
─────────────────────────────────────────────────────────────────────────────
season:    "summer"              →   /content/cq:tags/brand/seasons/summer
           "fall"   (alias)      →   /content/cq:tags/brand/seasons/autumn
market:    "EMEA"                →   /content/cq:tags/regions/emea
assetType: "hero banner"         →   /content/cq:tags/asset-type/hero-banner
brand:     "Firefly Pro"         →   /content/cq:tags/brand/products/firefly-pro
```

Target folder is **derived** from taxonomy — no manual folder selection:
```
/content/dam/campaigns / {market} / {season} / {assetType-slug}
                           emea      summer     hero-banners
```

Assets with unresolvable required taxonomy are **rejected with HTTP 422** so the agency fixes the upload form — not silently ingested with wrong tags.

### Firefly V3 Async vs V2 Sync

V2 sync calls block for 30–120 seconds. App Builder's default timeout is 60 seconds. V3 async:
```
POST /v3/images/generate-async  →  { jobId }  (returns in < 1 s)
GET  /v3/status/{jobId}         →  poll every 5 s, up to 5 minutes
```
The manifest sets `timeout: 300000` (5 min) to cover the full poll window.

### Brand Consistency via `style_reference`

```js
style: {
  imageReference: { source: { url: BRAND_STYLE_REFERENCE_URL } },
  strength: 60   // 0–100; 60 = brand flavour without overriding the text prompt
}
```
Store the brand hero in AEM DAM. Every AI-generated rendition inherits its colour palette, lighting, and visual tone — no per-prompt colour specifications needed.

---

## Setup

### Prerequisites

- Node.js ≥ 18
- Adobe Developer Console project with:
  - OAuth Server-to-Server credentials
  - Firefly API product added
  - AEM Assets API product added
  - Brand Portal (Content Hub) API product added
- Adobe Workfront with Event Subscriptions enabled
- Workfront Fusion workspace

### Installation

```bash
npm install
cp .env.example .env
# Populate .env with credentials from Adobe Developer Console
```

### Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `CLIENT_ID` | both actions | OAuth S2S client ID |
| `CLIENT_SECRET` | both actions | OAuth S2S client secret |
| `AIO_IMS_ORG_ID` | both actions | IMS Org ID (`@AdobeOrg`) |
| `AEM_HOST` | both actions | AEM author URL |
| `AEM_UPLOAD_BASE_PATH` | both actions | Root DAM folder |
| `CONTENT_HUB_HOST` | fusion-ingest | Brand Portal tenant URL |
| `FUSION_INGEST_SECRET` | fusion-ingest | Shared secret for Fusion HTTP module |
| `BRAND_STYLE_REFERENCE_URL` | orchestrate | Brand hero image for Firefly style reference |
| `FIREFLY_API_BASE_URL` | orchestrate | Firefly API base |
| `FIREFLY_NUM_VARIATIONS` | orchestrate | Renditions per job (default: 4) |
| `FIREFLY_POLL_INTERVAL_MS` | orchestrate | Poll delay (default: 5000) |
| `FIREFLY_POLL_MAX_ATTEMPTS` | orchestrate | Max poll iterations (default: 60) |
| `WORKFRONT_BASE_URL` | orchestrate | Workfront instance URL |
| `WORKFRONT_API_KEY` | orchestrate | Workfront API key |
| `WORKFRONT_WEBHOOK_SECRET` | orchestrate | HMAC-SHA256 webhook secret |

### Deploy

```bash
aio app deploy
```

Two action URLs are printed:
- `.../fusion-ingest` → configure in Workfront Fusion HTTP module
- `.../orchestrate` → register as Workfront Event Subscription URL

### Workfront Event Subscription setup

```bash
curl -X POST https://your-instance.my.workfront.com/attask/eventsubscription/api/v1/subscriptions \
  -H "apiKey: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "objCode": "DOCU",
    "eventType": "UPDATE",
    "url": "https://YOUR_NAMESPACE.adobeioruntime.net/api/v1/web/content-supply-chain/orchestrate",
    "authToken": "YOUR_WEBHOOK_HMAC_SECRET"
  }'
```

### Workfront Fusion scenario setup

1. Add a **Content Hub Watch** trigger module (or HTTP GET polling `/api/assets/ACME/contributions.json`)
2. Add a **Router** to filter only assets with `dam:contributionStatus = NEW`
3. Add an **HTTP POST** module:
   - URL: `https://YOUR_NAMESPACE.adobeioruntime.net/api/v1/web/content-supply-chain/fusion-ingest`
   - Header: `x-fusion-secret: YOUR_FUSION_INGEST_SECRET`
   - Body: `{ "assetPath": "{{assetPath}}", "agencyMetadata": { ... mapped from Content Hub fields ... } }`
4. Add a **Workfront Update Document** module using `aemAssetPath` from the response

### Extending the taxonomy

Edit `lib/taxonomy.js` — the `TAXONOMY_MAP` object. Each key is a metadata dimension; each value maps a lowercase agency string to a CQ tag path:

```js
market: {
  'middle east': '/content/cq:tags/regions/mena',  // add new region
  mena: '/content/cq:tags/regions/mena'
}
```

For enterprise scale, replace the static map with a runtime call to the AEM Tags API:
```
GET {aemHost}/bin/querybuilder.json?type=cq:Tag&path=/content/cq:tags/brand&p.limit=500
```

---

## Testing

```bash
npm test              # All unit tests
npm run test:coverage # With coverage report (threshold: 80%)
npm run lint          # ESLint
```

---

## Security

| Control | Where enforced |
|---|---|
| Workfront webhook authenticity | HMAC-SHA256 `X-WF-Signature`, first check in `orchestrate` |
| Fusion caller authenticity | Shared secret `x-fusion-secret` header, first check in `fusion-ingest` |
| IMS tokens | Resolved server-side via OAuth S2S — no user tokens stored |
| Secrets | App Builder environment bindings at runtime — never in code |
| Taxonomy validation | Hard reject (422) before any binary download if required fields unresolvable |
| Content Hub isolation | Agencies have no AEM author access; contribution folder is separate from production DAM |
