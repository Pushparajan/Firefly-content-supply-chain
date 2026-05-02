# ADR-007: Sequential Rendition Uploads to AEM

**Status:** Accepted

## Context

The Firefly generation job produces multiple renditions (default: 4). Each rendition must go through the full three-phase AEM Direct Binary Upload cycle (Initiate → Upload → Complete — see ADR-004). These uploads can, in principle, be executed in parallel to reduce total upload time.

However, the pipeline runs inside a single App Builder action invocation with a fixed memory budget (512 MB in `manifest.yml`) and a shared IMS token. Parallel uploads introduce complexity around:

- Memory: buffering all rendition binaries simultaneously (4 × ~5 MB = ~20 MB minimum, but could be larger).
- AEM author load: concurrent `initiateUpload` and `completeUpload` calls all hit the same AEM author instance.
- Error handling: partial failures in a parallel `Promise.all` require rollback or reconciliation logic.
- DAM workflow contention: multiple simultaneous `completeUpload` notifications can cause workflow queue pressure.

Options considered:

| Option | Notes |
|--------|-------|
| **Sequential upload (current)** | Simple; predictable AEM load; easy error propagation; no concurrency management code |
| `Promise.all` (fully parallel) | Fastest; risks AEM overload and memory spikes; complex error handling |
| `Promise.allSettled` with concurrency limit | Balanced; adds a concurrency-limiter dependency; increases implementation complexity |
| Queue-based async processing | Decoupled; overkill for 2–8 renditions; requires additional infrastructure |

## Decision

Upload renditions **sequentially** using a `for` loop in `lib/aem-cloud.js::uploadRenditionsToAem`:

```js
for (let i = 0; i < fireflyOutputs.length; i++) {
  // fetchRemoteAsset → initiateUpload → uploadBinaryToCloud → completeUpload
}
```

Each rendition is fully uploaded and confirmed before the next begins. A warning is logged and the rendition skipped if its image URL is absent, so a single bad output does not abort the remaining uploads.

## Consequences

**Positive:**
- Memory footprint is bounded to one rendition buffer at a time (typically 3–10 MB).
- AEM author receives one `initiateUpload` + one `completeUpload` per rendition in a steady cadence, avoiding request spikes.
- A failure on any rendition surfaces a clear error with the offending file name; preceding renditions are already committed to AEM.
- No additional concurrency-limiting library is required.

**Negative:**
- Total upload time scales linearly with rendition count: 4 renditions × ~3 s per upload ≈ 12 s. With the 300-second action timeout, this is acceptable for up to ~80 renditions.
- Slow or flaky AEM responses block all subsequent renditions in the same invocation.

**Neutral:**
- The code comment in `uploadRenditionsToAem` explicitly notes the parallel alternative (`Promise.allSettled` with a concurrency limiter) so future contributors understand the trade-off and can upgrade if throughput becomes a concern.
- Rendition count is configurable via `FIREFLY_NUM_VARIATIONS`; default is 4, which keeps sequential upload time well within the timeout window.
