# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the Firefly Content Supply Chain project.

ADRs capture significant architectural choices, the context that drove each decision, and their consequences. Each record is immutable once accepted — superseding decisions reference the record they replace.

## Index

| # | Title | Status |
|---|-------|--------|
| [ADR-001](ADR-001-adobe-app-builder-runtime.md) | Adobe App Builder as Runtime Platform | Accepted |
| [ADR-002](ADR-002-firefly-v3-async-api.md) | Firefly V3 Async API over V2 Synchronous | Accepted |
| [ADR-003](ADR-003-brand-style-reference.md) | Brand Consistency via `style_reference` | Accepted |
| [ADR-004](ADR-004-aem-direct-binary-upload.md) | AEM Direct Binary Upload (3-Phase Protocol) | Accepted |
| [ADR-005](ADR-005-oauth-server-to-server.md) | OAuth Server-to-Server (S2S) Authentication | Accepted |
| [ADR-006](ADR-006-hmac-webhook-verification.md) | HMAC-SHA256 Workfront Webhook Verification | Accepted |
| [ADR-007](ADR-007-sequential-aem-uploads.md) | Sequential Rendition Uploads to AEM | Accepted |

## Format

Each ADR follows the template:

```
# ADR-NNN: Title

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Context
What situation or problem forced this decision?

## Decision
What was decided?

## Consequences
What are the results — positive, negative, and neutral?
```
