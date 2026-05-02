# ADR-006: HMAC-SHA256 Workfront Webhook Verification

**Status:** Accepted

## Context

The `orchestrate` App Builder action is exposed as a public HTTPS endpoint (`web: 'yes'`). Any party that knows the URL could POST a forged payload and trigger image generation and AEM ingestion, wasting API quota and potentially polluting the DAM.

Workfront Event Subscriptions support an optional `authToken` field. When set, Workfront signs every outbound webhook body with HMAC-SHA256 using that token as the key and places the hex-encoded digest in the `X-WF-Signature` request header.

Options considered:

| Option | Notes |
|--------|-------|
| **HMAC-SHA256 signature verification** | Cryptographically binds each request to the shared secret; timing-safe comparison; standard practice |
| IP allowlisting | Workfront IP ranges change; brittle in multi-region deployments |
| mTLS | Requires certificate management; not natively supported by Workfront Event Subscriptions |
| `require-adobe-auth: true` (IMS token) | Would require Workfront to obtain an IMS token — not supported by Event Subscriptions |
| No verification | Unacceptable; exposes the action to replay and spoofing attacks |

## Decision

Verify every inbound request using **HMAC-SHA256 signature verification** before any processing begins.

The verification is performed in `lib/workfront.js::verifyWebhookSignature`:

```js
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error('X-WF-Signature header is missing')

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')

  const expectedBuf = Buffer.from(expected, 'hex')
  const receivedBuf = Buffer.from(signatureHeader, 'hex')

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error('Webhook signature verification failed')
  }
}
```

Key design choices:

- **`crypto.timingSafeEqual`** is used instead of `===` to prevent timing-oracle attacks that could allow an attacker to guess the HMAC byte-by-byte.
- The **raw unparsed body** (`params.__ow_body`) is signed, not the parsed JSON object, to avoid canonicalisation ambiguities.
- Verification happens at **Step 1** of the action, before IMS token resolution or any external API call, so forged requests are rejected with minimal resource consumption (HTTP 401).
- The shared secret is stored in `WORKFRONT_WEBHOOK_SECRET` and injected via App Builder environment bindings.

`require-adobe-auth: false` is set in `manifest.yml` because Workfront cannot supply an Adobe IMS token; authentication is handled entirely by this HMAC mechanism.

## Consequences

**Positive:**
- Forged or replayed requests are rejected immediately with a `401` response and zero downstream API cost.
- Timing-safe comparison closes the timing-oracle attack vector.
- No external service call is needed for verification — the check is purely in-process.
- Rotating the secret requires only updating the App Builder environment variable and the Workfront Event Subscription `authToken`.

**Negative:**
- HMAC does not prevent replay attacks on its own (the same valid request can be re-sent). A nonce or timestamp check would be needed to prevent replays; this is not currently implemented.
- If `WORKFRONT_WEBHOOK_SECRET` is compromised, an attacker can forge valid signatures until the secret is rotated.
- The action endpoint URL must be kept confidential as an additional layer of obscurity; publishing it alone would still require the attacker to forge a valid HMAC.

**Neutral:**
- App Builder passes the raw body as `params.__ow_body` as a string; the action must not parse it before calling `verifyWebhookSignature`.
- The Workfront `authToken` field in Event Subscriptions is the same value as `WORKFRONT_WEBHOOK_SECRET`.
