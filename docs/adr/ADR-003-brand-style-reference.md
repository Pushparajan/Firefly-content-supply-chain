# ADR-003: Brand Consistency via `style_reference`

**Status:** Accepted

## Context

Every piece of AI-generated content must align with the brand's visual identity — colour palette, lighting mood, compositional style, and overall aesthetic — regardless of the specific text prompt supplied by a Workfront document.

Without a mechanism to anchor the generation to brand aesthetics, each prompt would produce visually inconsistent results, requiring expensive manual review and correction before assets could be used in campaigns.

Options considered:

| Option | Notes |
|--------|-------|
| **`style.imageReference` (style_reference)** | Firefly-native; references an existing brand hero image URL; no prompt engineering required |
| Embed brand attributes in every prompt | Brittle; requires all callers to know and duplicate brand descriptors; hard to maintain |
| Fine-tune a custom Firefly model on brand imagery | High cost, long lead time, requires Adobe custom model program access |
| Post-processing colour grading pipeline | Adds latency and complexity; does not affect composition or lighting |

## Decision

Pass a **brand style reference image** in every Firefly generation request via the `style.imageReference` field:

```js
style: {
  imageReference: {
    source: { url: brandStyleReferenceUrl }
  },
  strength: 60   // 0–100; 60 inherits brand palette/mood without overriding the prompt
}
```

The reference image (a brand hero image) is stored in AEM DAM or any publicly accessible CDN URL. Its location is provided through the `BRAND_STYLE_REFERENCE_URL` environment variable so it can be changed without a code deployment.

A `strength` of `60` was chosen as the default because it provides strong visual alignment with the brand while still allowing the text prompt sufficient influence to produce meaningfully varied content.

## Consequences

**Positive:**
- Brand consistency is enforced at the API level on every job, with no per-prompt engineering needed.
- Changing the brand reference image (e.g., seasonal refresh) requires only updating `BRAND_STYLE_REFERENCE_URL` — no code change or redeployment.
- `strength` is a numeric constant that can be made environment-configurable if brand teams need to experiment.
- Works with any public HTTPS image URL, including AEM DAM renditions served via Dispatcher.

**Negative:**
- If `BRAND_STYLE_REFERENCE_URL` is unset or the URL is unreachable, the job is rejected immediately (`brandStyleReferenceUrl is required` error in `lib/firefly-v3.js`).
- The reference image must remain publicly accessible for the duration of the generation job; a broken URL mid-flight will fail the job.
- Very high `strength` values (> 80) can suppress prompt influence, reducing content diversity.

**Neutral:**
- The `strength` parameter and brand URL are validated before the API call is made, providing fast-fail behaviour rather than a delayed Firefly error response.
- The brand reference URL is logged (truncated) at info level for traceability without exposing full pre-signed URLs.
