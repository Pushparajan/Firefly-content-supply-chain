# ADR-009: Adobe Workfront Fusion Considered as Orchestration Alternative

**Status:** Accepted

## Context

Adobe Workfront Fusion (formerly Integromat) is a visual, no-code/low-code workflow automation platform deeply integrated with Workfront. It offers pre-built connectors for Workfront, Adobe Experience Cloud products, and hundreds of third-party services. It was a natural candidate for orchestrating the Creative → Firefly → AEM pipeline.

The pipeline requires:

1. Receiving a Workfront document event.
2. Calling the Firefly V3 Async API (submit job → poll status → retrieve outputs).
3. Uploading binary renditions to AEM via the 3-phase Direct Binary Upload protocol.
4. Writing results back to a Workfront record.

Options considered for the orchestration layer:

| Option | Notes |
|--------|-------|
| **Adobe App Builder (chosen — see ADR-001)** | Custom serverless actions; full Node.js; native IMS/OAuth; tight control over async polling and binary streaming |
| **Workfront Fusion scenarios** | Visual drag-and-drop builder; native Workfront module; HTTP/webhook modules available; limited code-level control |
| AWS Step Functions / Azure Logic Apps | External to the Adobe ecosystem; adds cross-cloud complexity and credential management overhead |

## Decision

**Do not use Workfront Fusion as the primary orchestration layer.** Use Adobe App Builder (see ADR-001) with Workfront Event Subscriptions (see ADR-008) as the trigger.

Workfront Fusion was evaluated and rejected for the following reasons:

### 1. No native Firefly V3 Async support

Fusion has no built-in Firefly connector. Implementing the submit → poll loop requires chaining multiple HTTP modules with custom error handling. The Fusion scenario execution model is inherently request/response per module step; a polling loop requires a Router + Iterator + Repeater pattern that is fragile and difficult to tune for variable generation latency.

App Builder's `generateAndWait` helper in `lib/firefly-v3.js` implements the same loop in ~30 lines of idiomatic Node.js with configurable intervals and a clean `await` interface.

### 2. Direct Binary Upload complexity

The AEM Direct Binary Upload protocol (ADR-004) requires streaming a binary buffer from a Firefly pre-signed URL to an Azure Blob pre-signed URI, then posting a completion notification. Fusion's HTTP module does not support piped binary streaming between two pre-signed endpoints without buffering the full payload in Fusion's memory, which introduces throughput limits and costs additional Fusion data-transfer quota.

### 3. Execution time limits

Fusion imposes a per-scenario execution time limit (typically 40 seconds on standard plans). The combined Firefly polling window (up to 300 seconds) exceeds this limit and would require splitting the workflow across multiple scenarios linked by data stores or webhooks — significantly increasing operational complexity.

App Builder's `manifest.yml` sets `timeout: 300000` and the pipeline runs entirely within a single action invocation.

### 4. Secret management

Fusion stores credentials in connection records within the Fusion UI. For an enterprise deployment, this means secrets (IMS client secret, AEM service token, Workfront API key) live outside the Adobe Developer Console / App Builder credential store, creating a second secret-management surface to audit and rotate.

App Builder injects all secrets as environment params per-invocation; rotation requires a single `aio app deploy` update.

### 5. Testing and CI/CD

Fusion scenarios cannot be version-controlled, unit-tested, or deployed through a standard CI/CD pipeline without the Workfront Fusion API. The App Builder codebase uses Jest unit tests (`npm test`) and deploys via `aio app deploy`, both of which integrate with standard developer toolchains.

### When Fusion is appropriate

Workfront Fusion remains a valid choice for simpler integrations that:

- Do not involve long-running async APIs requiring multi-minute polling.
- Transfer small payloads (< a few MB) between systems.
- Are owned by business/operations teams who prefer a visual builder over code.
- Do not require the fine-grained binary streaming needed for large rendition uploads.

Fusion could be used as a **complementary layer** — for example, a Fusion scenario could watch for a Workfront project status change (a coarse trigger) and then call the App Builder action endpoint via an HTTP module, keeping the heavy lifting in App Builder while giving non-technical users a visual workflow view.

## Consequences

**Positive (of choosing App Builder over Fusion):**
- Full control over the async polling loop, binary streaming, and error-recovery logic.
- Single secret-management surface (Adobe Developer Console / App Builder environment bindings).
- Code is version-controlled, unit-tested, and deployed through standard CI/CD tooling.
- No Fusion licensing cost or execution-minute quota to manage.
- Execution time up to 5 minutes in a single invocation, well above Fusion's per-execution limit.

**Negative:**
- Requires Node.js development skills; not accessible to non-technical operators who could configure a Fusion scenario without code.
- Changes require a code deployment (`aio app deploy`) rather than a scenario publish in the Fusion UI.
- Debugging uses `aio app logs` rather than Fusion's visual execution history.

**Neutral:**
- Fusion and App Builder are not mutually exclusive. A hybrid architecture (Fusion for coarse orchestration, App Builder for compute-intensive steps) is viable and may be revisited as Fusion's Firefly connector ecosystem matures.
- The Workfront Fusion connector for AEM Assets is also limited at time of writing; the Direct Binary Upload protocol must be implemented manually in either platform.
