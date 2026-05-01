# Firefly Content Supply Chain

Adobe App Builder action that automates the Creative → Approval → Distribution pipeline:

```
Workfront Event  →  Firefly V3 Async  →  AEM Assets (Direct Binary Upload)
   (webhook)          (generation)            (DAM ingestion)
```

## Architecture

```
actions/orchestrate/index.js   ← Web action entry point (App Builder)
lib/
  workfront.js    ← Webhook HMAC verification + Workfront REST API
  firefly-v3.js   ← Firefly V3 async job submit + poll pattern
  aem-cloud.js    ← AEM Direct Binary Upload (Initiate → Upload → Complete)
  ims.js          ← OAuth Server-to-Server token resolution
manifest.yml      ← App Builder runtime config (timeout: 300 s, web: yes)
```

### Firefly V3 Async Pattern

Older V2 synchronous calls fail in App Builder because the 60-second runtime limit is shorter than AI generation time. V3 Async decouples submission from completion:

```
POST /v3/images/generate-async  →  { jobId }
GET  /v3/status/{jobId}         →  { status: "running" | "succeeded" | "failed" }
```

The action polls on a configurable interval (default 5 s × 60 attempts = 5-minute window), well within the 300-second manifest timeout.

### Brand Consistency via `style_reference`

Every Firefly call includes:

```js
style: {
  imageReference: { source: { url: BRAND_STYLE_REFERENCE_URL } },
  strength: 60   // 0-100; inherits brand palette/mood without overriding prompt
}
```

Store your brand hero image in AEM DAM and set `BRAND_STYLE_REFERENCE_URL` in `.env`.

### AEM Direct Binary Upload

```
1. POST {aem}/content/dam/folder.initiateUpload.json   → uploadToken + uploadURIs
2. PUT  {pre-signed Azure Blob URI}                    → binary bypass (no AEM traffic)
3. POST {completeURI}                                  → triggers DAM workflows
```

## Setup

### Prerequisites

- Node.js ≥ 18
- Adobe Developer Console project with:
  - OAuth Server-to-Server credentials
  - Firefly API product added
  - AEM Assets API product added
- Adobe Workfront with Event Subscriptions enabled

### Installation

```bash
npm install
cp .env.example .env
# Populate .env with credentials from Adobe Developer Console
```

### Environment Variables

| Variable | Description |
|---|---|
| `CLIENT_ID` | OAuth S2S client ID |
| `CLIENT_SECRET` | OAuth S2S client secret |
| `AIO_IMS_ORG_ID` | IMS Org ID (`@AdobeOrg`) |
| `BRAND_STYLE_REFERENCE_URL` | HTTPS URL to brand hero image for style reference |
| `FIREFLY_API_BASE_URL` | Firefly API base (default: `https://firefly-api.adobe.io`) |
| `FIREFLY_NUM_VARIATIONS` | Renditions per job (default: `4`) |
| `FIREFLY_POLL_INTERVAL_MS` | Poll delay in ms (default: `5000`) |
| `FIREFLY_POLL_MAX_ATTEMPTS` | Max poll iterations (default: `60`) |
| `AEM_HOST` | AEM author URL |
| `AEM_UPLOAD_BASE_PATH` | DAM folder for generated assets |
| `WORKFRONT_BASE_URL` | Workfront instance URL |
| `WORKFRONT_API_KEY` | Workfront API key |
| `WORKFRONT_WEBHOOK_SECRET` | HMAC-SHA256 shared secret for webhook verification |

### Deploy

```bash
aio app deploy
```

The deployed action URL is shown in the output. Register it as a Workfront Event Subscription endpoint for `DOCU` `UPDATE` events.

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

## Testing

```bash
npm test              # Unit tests
npm run test:coverage # With coverage report
npm run lint          # ESLint
```

## Security

- Webhook authenticity is enforced via HMAC-SHA256 (`X-WF-Signature` header) before any processing begins.
- IMS tokens are resolved server-side via OAuth S2S; no user tokens are stored.
- All secrets are injected at runtime via App Builder environment bindings — never hardcoded.
- Firefly output URLs are pre-signed with short TTLs; binaries are streamed directly to AEM without local disk writes.
