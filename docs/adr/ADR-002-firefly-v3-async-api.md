# ADR-002: Firefly V3 Async API over V2 Synchronous

**Status:** Accepted

## Context

Adobe Firefly image generation is computationally intensive. Generation time for a single job varies from a few seconds to well over a minute depending on model load, requested resolution, and the number of variations.

Adobe App Builder (OpenWhisk) imposes a **hard 60-second default action timeout**. A synchronous Firefly V2 call (`POST /v2/images/generate`) that blocks until images are ready will regularly exceed this limit, causing the action to be forcibly terminated with no result delivered to the caller.

The manifest can raise the timeout up to 3 600 000 ms, but a single blocking HTTP call cannot be kept alive for an arbitrary duration by the action runtime.

## Decision

Use the **Firefly V3 Async API**, which decouples job submission from job completion:

1. `POST /v3/images/generate-async` — submits the generation job; returns a `{ jobId, statusUrl }` immediately (< 1 s).
2. `GET /v3/status/{jobId}` — polled repeatedly by the same action until `status` is `"succeeded"` or `"failed"`.

The action timeout in `manifest.yml` is raised to **300 000 ms (5 minutes)**. The poll loop defaults to 5-second intervals with up to 60 attempts (5-minute window), keeping the total execution time well within the extended timeout.

```js
// lib/firefly-v3.js — poll loop
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const status = await client.getJobStatus(jobId)
  if (status?.status === 'succeeded') return status.outputs
  if (status?.status === 'failed')   throw new Error(...)
  await sleep(intervalMs)
}
```

Both `FIREFLY_POLL_INTERVAL_MS` and `FIREFLY_POLL_MAX_ATTEMPTS` are environment-configurable so the cadence can be tuned without code changes.

## Consequences

**Positive:**
- Eliminates the hard-timeout risk that plagued V2 synchronous calls.
- The action can handle generation times from 2 seconds to nearly 5 minutes within a single invocation.
- Poll interval and max-attempts are runtime-configurable, supporting future model changes without redeployment.
- The `generateAndWait` convenience helper in `lib/firefly-v3.js` encapsulates the full submit → poll cycle behind a single `await`.

**Negative:**
- Polling introduces a minimum latency of one `intervalMs` tick even for fast jobs.
- If the Firefly status endpoint experiences degraded availability, polling may consume the full timeout before returning a failure.
- Each poll request counts against Firefly API rate limits; very short intervals could trigger throttling.

**Neutral:**
- Linear back-off is used (constant interval). Exponential back-off could be adopted in future to reduce API call volume for slow jobs.
- The approach is entirely contained in `lib/firefly-v3.js`; callers see only the `generateAndWait` interface.
