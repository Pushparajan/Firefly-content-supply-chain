# ADR-004: AEM Direct Binary Upload (3-Phase Protocol)

**Status:** Accepted

## Context

Firefly generates multiple high-resolution renditions (default: 4 × 2048 × 2048 px). Each image binary must be ingested into AEM as a Cloud Service (AEMaaCS) and have its associated DAM asset node created so that downstream workflows (metadata extraction, rendition generation, review) can run.

Options for uploading binaries to AEMaaCS:

| Option | Notes |
|--------|-------|
| **Direct Binary Upload (Initiate → Upload → Complete)** | AEMaaCS-native; binary bypasses AEM author; scales to large files |
| Classic `POST /content/dam/…` multipart upload | Sends binary through AEM author tier; limited to ~100 MB; high memory pressure on AEM |
| AEM Assets HTTP API (`/api/assets/…`) | Wrapper over the classic path; same throughput ceiling |
| Sling POST Servlet | Not recommended for programmatic integrations; same bottleneck |

## Decision

Use the **AEM Direct Binary Upload (DBA) protocol** implemented in `lib/aem-cloud.js`:

### Phase 1 — Initiate
`POST {aemHost}{folderPath}.initiateUpload.json`

Sends file names and sizes; AEM responds with a `completeURI` and one or more pre-signed cloud-storage `uploadURIs` per file.

### Phase 2 — Upload binary to cloud storage
`PUT {pre-signed Azure Blob URI}`

The binary is streamed directly from the App Builder action's memory to Azure Blob Storage (AEM's underlying object store). AEM author is **not** in the data path, eliminating the author-tier bandwidth bottleneck.

### Phase 3 — Complete
`POST {completeURI}`

Notifies AEM that the binary has landed in cloud storage. AEM creates the asset JCR node and triggers configured DAM workflows (e.g., `DAM Update Asset`).

Each rendition goes through all three phases independently within `uploadRenditionsToAem`.

## Consequences

**Positive:**
- Binary transfer bypasses the AEM author JVM entirely, enabling throughput limited only by the pre-signed blob-storage endpoint — typically hundreds of MB/s.
- Large files (up to ~5 GB with a single PUT) are supported without chunking changes.
- DAM workflows (metadata extraction, rendition generation) are triggered automatically via the complete call.
- `createVersion: true` ensures existing assets are versioned rather than silently overwritten.

**Negative:**
- The three-phase flow is more complex to implement and test than a single upload call.
- Pre-signed `uploadURIs` have short TTLs; if Phase 1 and Phase 2 are separated by unexpected delays the URI may expire.
- Multi-part chunked upload (for files > 5 GB) is not yet implemented; `uploadURIs[0]` is always used.

**Neutral:**
- The `completeURI` returned by Phase 1 may be relative or absolute; `lib/aem-cloud.js` normalises both cases.
- MIME type is inferred from the `content-type` response header of the Firefly pre-signed URL and mapped to a file extension via `mimeToExt`.
- The protocol is the same for AEM 6.5 on-premise and AEMaaCS; only the host URL differs.
