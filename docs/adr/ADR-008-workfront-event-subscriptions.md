# ADR-008: Workfront Event Subscriptions as Pipeline Trigger

**Status:** Accepted

## Context

The Content Supply Chain pipeline must begin processing as soon as a creative asset is ready in Adobe Workfront. The trigger mechanism determines latency, infrastructure cost, coupling, and operational complexity.

The system needs to:

- React to document-level state changes (e.g. a document uploaded or updated on a task).
- Invoke the App Builder orchestration action without human intervention.
- Avoid polling-induced latency or wasted API quota during quiet periods.
- Operate entirely within the Adobe ecosystem.

Options considered:

| Option | Notes |
|--------|-------|
| **Workfront Event Subscriptions (webhooks)** | Native push mechanism; sub-second delivery; no polling; configurable per object type and event type |
| Polling the Workfront REST API | Requires a scheduled job; introduces up-to N-second latency; wastes API quota on unchanged records |
| Workfront Fusion scenario (watch trigger) | Fusion's built-in Workfront module polls on a configurable schedule (minimum 5 minutes on free tier); introduces Fusion as an additional platform dependency (see ADR-009) |
| Workfront Automation (no-code rules) | Supports in-platform notifications but cannot call arbitrary external HTTPS endpoints |
| Adobe I/O Events for Workfront | Preview/limited availability at time of implementation; not yet generally available for Workfront DOCU events |

## Decision

Use **Workfront Event Subscriptions** to push webhook notifications directly to the App Builder action endpoint.

A subscription is registered via the Workfront Event Subscription API:

```bash
curl -X POST https://{instance}.my.workfront.com/attask/eventsubscription/api/v1/subscriptions \
  -H "apiKey: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "objCode":   "DOCU",
    "eventType": "UPDATE",
    "url":       "https://{namespace}.adobeioruntime.net/api/v1/web/content-supply-chain/orchestrate",
    "authToken": "YOUR_WEBHOOK_HMAC_SECRET"
  }'
```

Key design choices:

- **`objCode: "DOCU"`** — Subscriptions are scoped to document objects, so project/task updates do not generate spurious invocations.
- **`eventType: "UPDATE"`** — Fires on every document update, including version uploads and status field changes.
- **`authToken`** — Workfront uses this value as the HMAC-SHA256 key when signing the outbound request body (placed in `X-WF-Signature`). The action verifies this signature before any processing (see ADR-006).
- The `orchestrate` action filters on `objCode !== 'DOCU'` early in its execution path, discarding any non-document events that reach the endpoint.

The integration is entirely stateless: Workfront delivers the event, the action processes it end-to-end, and no persistent job queue is required.

## Consequences

**Positive:**
- Near-real-time triggering — Workfront delivers the webhook within seconds of the document change.
- Zero polling cost: the App Builder action is only invoked when an actual event occurs, minimising both API quota usage and cold-start frequency.
- Workfront natively signs each request with HMAC-SHA256, enabling the cryptographic verification in ADR-006.
- Subscriptions can be scoped finely (object type + event type) to minimise noise.
- No additional infrastructure (scheduler, queue) is required; the trigger is fully managed by Workfront.

**Negative:**
- Webhook delivery is at-least-once; duplicate events are possible if Workfront retries after a timeout. The action is currently not idempotent — repeated processing of the same `objID` will re-generate and re-upload renditions.
- If the App Builder endpoint is unreachable, Workfront retries with exponential back-off but eventually drops the event; there is no dead-letter queue.
- The subscription URL must be updated manually whenever the App Builder namespace or action name changes.
- `objCode: "DOCU"` + `eventType: "UPDATE"` is a broad filter; every document edit triggers the full pipeline. Additional filtering on `newState` fields (e.g. a custom approval status) should be added to avoid unnecessary Firefly generation.

**Neutral:**
- Workfront Event Subscriptions are managed through the REST API; there is no UI for listing or deleting subscriptions. The `GET /attask/eventsubscription/api/v1/subscriptions` endpoint can be used for inventory.
- A single Workfront instance supports up to 1 000 concurrent event subscriptions; this pipeline requires exactly one.
- The `authToken` in the subscription record corresponds 1:1 to `WORKFRONT_WEBHOOK_SECRET` in App Builder environment bindings.
