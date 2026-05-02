# ADR-005: OAuth Server-to-Server (S2S) Authentication

**Status:** Accepted

## Context

The pipeline must authenticate against multiple Adobe services (Firefly API, AEM Assets API) using a single long-lived credential. The action runs headlessly — there is no interactive user session and no browser redirect possible.

Authentication approaches considered:

| Option | Notes |
|--------|-------|
| **OAuth Server-to-Server (S2S)** | Current Adobe-recommended S2S credential type; no JWT; supports all required API scopes |
| JWT Service Account (deprecated) | Deprecated by Adobe in 2024; will be removed from Developer Console |
| User access token (OAuth 2.0 PKCE) | Requires an interactive user; not suitable for server-side automation |
| API-key-only auth | Insufficient for AEM Assets and Firefly; both require bearer tokens |

## Decision

Use **OAuth Server-to-Server credentials** managed via the `@adobe/aio-sdk` IMS context:

```js
// lib/ims.js
const imsClient = await IMS.createImsClient({
  clientId,
  clientSecret,
  imsOrgId,
  scopes: ['AdobeID', 'openid', 'firefly_api', 'ff_apis', 'aem_assets_api']
})
const token = (await imsClient.getAccessToken()).access_token
```

The resolved token is a short-lived bearer token valid for all downstream API calls within a single action invocation. `CLIENT_ID` and `CLIENT_SECRET` are never stored outside of App Builder's encrypted environment bindings.

The required scopes are:

| Scope | Purpose |
|-------|---------|
| `AdobeID`, `openid` | Base IMS identity |
| `firefly_api`, `ff_apis` | Firefly V3 API access |
| `aem_assets_api` | AEM Assets write access |

## Consequences

**Positive:**
- Aligns with Adobe's current (and future) recommended credential model; JWT is deprecated.
- A single token resolution call covers all downstream services — no per-service credential management.
- Tokens are short-lived (typically 24 hours); there is no long-lived secret that can be leaked from memory.
- The `@adobe/aio-sdk` IMS client handles token caching and renewal transparently.
- Credentials are injected via App Builder environment bindings and are never written to disk or logs.

**Negative:**
- If `CLIENT_ID` or `CLIENT_SECRET` are missing or misconfigured, the action fails at the IMS step (Step 3) rather than at startup, making misconfiguration harder to catch without a health-check endpoint.
- The IMS token resolution adds ~200–500 ms to each cold invocation.

**Neutral:**
- `TECHNICAL_ACCOUNT_ID` and `TECHNICAL_ACCOUNT_EMAIL` are included in the environment bindings for completeness and may be required by some SDK versions, but `resolveImsToken` uses only `CLIENT_ID`, `CLIENT_SECRET`, and `AIO_IMS_ORG_ID` for token resolution.
- Token expiry within a single (long) action invocation is not handled; for invocations approaching the 300-second timeout, a token refresh strategy may be needed in future.
