# ADR-001: Adobe App Builder as Runtime Platform

**Status:** Accepted

## Context

The Content Supply Chain pipeline must run as a server-side, event-driven workload triggered by Workfront webhooks. It needs to:

- Accept inbound HTTPS webhook calls from Workfront Event Subscriptions.
- Invoke the Adobe Firefly API and the AEM Assets API using OAuth Server-to-Server credentials.
- Operate within the Adobe ecosystem without managing infrastructure.
- Securely store secrets (client ID, client secret, HMAC keys) without embedding them in source code.

Options considered:

| Option | Notes |
|--------|-------|
| **Adobe App Builder (OpenWhisk actions)** | Serverless, Adobe-managed, native IMS/OAuth integration, environment-param injection, webhook-ready |
| AWS Lambda + API Gateway | Requires external secret management (SSM / Secrets Manager) and manual Adobe credential handling |
| Azure Functions | Same drawbacks as Lambda; no native Adobe SDK alignment |
| Dedicated Node.js server (e.g., Express on AKS) | Over-engineered for a single-pipeline workload; operational burden |

## Decision

Use **Adobe App Builder** (built on Apache OpenWhisk) as the sole runtime platform.

The orchestration logic is packaged as a single web action (`actions/orchestrate/index.js`) declared in `manifest.yml`. All secrets are injected at runtime through App Builder environment bindings — no secrets are stored in source code or container images.

## Consequences

**Positive:**
- Zero infrastructure to provision or maintain; Adobe manages the underlying OpenWhisk cluster.
- Native integration with Adobe IMS, Firefly APIs, and AEM via the `@adobe/aio-sdk` family.
- Environment params are encrypted at rest by the App Builder platform and injected per-invocation.
- The `aio app deploy` CLI command provides a single-step deployment workflow.
- Cold-start latency is acceptable for webhook-triggered, non-interactive workloads.

**Negative:**
- The default action timeout is 60 seconds — too short for synchronous AI generation. This is addressed by ADR-002 (Firefly V3 Async API) and by setting `timeout: 300000` in `manifest.yml`.
- Debugging requires the `aio app logs` toolchain rather than standard server logs.
- Local development requires the App Builder development server (`aio app dev`).

**Neutral:**
- Maximum action timeout is 3 600 000 ms (1 hour); the pipeline stays well within that limit.
- Concurrency is configurable per action (`concurrency: 50` in `manifest.yml`).
