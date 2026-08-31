# PrincipalLatch — submission copy and evidence checklist

> Draft for **TikTok TechJam 2026 — Track 1: Bouncer**. Do not mark the
> submission final until every unchecked evidence gate at the end is completed.
> Public cloud deployment is optional and is not claimed.

## Devpost-wide submission requirements

The current event page and rules require an English written description of the
solution and technology stack, a **public** code repository with a comprehensive
README, and a **public YouTube demo no longer than three minutes** showing the
working solution end to end. Judges must also receive unrestricted, free access
to a working project or test build during judging. These event-wide gates are in
addition to the Track 1 deliverables below.

Ready-to-paste English fields and testing instructions are maintained in
[DEVPOST_SUBMISSION.md](DEVPOST_SUBMISSION.md).

## Project title

**PrincipalLatch — Agent Session Identity and Revocable Delegated Authority**

## Short description

An Agent should not silently inherit every permission of the human who launched
it. PrincipalLatch gives a real Codex Agent a short-lived signed session identity,
then evaluates the human's current signed delegation at a trusted Fastify
resource boundary.

The demo uses one Agent owned by Alice. In Turn 1, the backend allows it to read
Alice's generated mock document but returns `403 DENY_OWNER_MISMATCH` before
Bob's protected provider is called. Alice then revokes the current Mandate. In
Turn 2, the same still-valid Agent Passport is rejected even for Alice's own
document because identity remains valid while authority is gone. Persisted
audit evidence records the Human, Agent, action, resource, decision, reason,
Mandate revision, and provider outcome.

Bob is not a second user logged into Alice's Runtime, a second tenant, or part
of an Agent Team. He is the independent negative-control resource owner required
to prove cross-user backend enforcement.

## Problem and insight

Human login answers “who is using the UI?” but not “which autonomous process is
making this request, for whom, and under what current authority?” Prompt-level
rules cannot answer that safely because the model can ignore them and cannot be
trusted to derive resource ownership.

PrincipalLatch separates three facts:

1. **Human fixture:** `user:alice` is the selected Agent owner persona.
2. **Agent identity:** `agent:alice-researcher` presents a short-lived Agent
   Session Passport that binds it to Alice and a Runtime session.
3. **Current authority:** a separately signed Mandate binds `principal × agent`,
   lifecycle, revision, and a committed enforcement profile.

The trusted backend—not the prompt—derives the action and resource owner, loads
the current Mandate, and decides whether private content may be read.

## Official requirement mapping

Source: organizer
[Track 1 Bouncer guide](https://github.com/RrankPyramid/CodeJam/blob/main/docs/HACKATHON_EXTENSION_GUIDE.md#bouncer-identity-and-authorization).

| Official Track 1 requirement | Concrete PrincipalLatch proof |
| --- | --- |
| Create User A and User B | `user:alice` and `user:bob` are distinct server-side principal/resource-owner fixtures. Only Alice has a browser demo session; Bob owns the negative-control resource. |
| Agent principal owned by User A | `agent:alice-researcher` is owned by Alice in server state and the current signed Mandate. |
| Allow User A's mock resource | The Gateway records `ALLOW_SCOPE_RULE`; only then can `alice-doc-001` reach the provider. |
| Deny User B's mock resource in the backend | The same Agent receives HTTP `403 DENY_OWNER_MISMATCH`; Bob's outcome is `not_attempted` and audited successful reads stay `0`. |
| Record Human, Agent, action, resource, decision | Gateway audit rows contain all five fields plus reason, Mandate ID/revision, Passport commitment, and provider outcome. |
| Demonstrate a real Agent Run | The primary judging path uses Codex CLI in a disposable Runtime container with Volcengine Ark. Final live evidence remains a submission gate. |
| Code repository and architecture/live-demo materials | Repository access/URL, final commit, one-page diagram, and ≤3-minute real-Agent demo remain final delivery gates. |

Revocation, same-Passport lifecycle denial, current-evidence state, signed profile
commitments, and safe successor rehearsal are additional product capabilities.

## Why this is Agent middleware

The Agent cannot choose its Human principal, Passport claims, Mandate body,
policy revision, action, resource kind, or owner. A valid Passport is necessary
but insufficient: for each admitted, syntactically valid Gateway attempt, the
Gateway independently loads and verifies current authority. This creates a
runtime enforcement boundary instead of a
chatbot that merely promises to follow access rules.

## Technical design

### Agent Session Passport

The trusted control plane issues a compact Ed25519 JWS with a strict protected
header and strict claims for issuer, Agent (`sub`), acting persona (`act`),
Runtime session, Mandate, audience, issue/not-before/expiry time, and unique
token ID. Lifetime is at most 300 seconds. The credential contains identity
context, not resource permissions.

The application injects the Passport into the real Runtime environment. It is
not put in the prompt or argv, and Human/browser/audit/persisted Run credential
fields expose only safe `jti`, expiry, and SHA-256 commitments. Known secrets are
redacted from captured child output. This is an application-layer statement,
not a guarantee about engine-admin inspection or external host telemetry.

### Current signed Mandate

The Mandate is the durable `principal × agent` delegation. It commits to a
closed-world Enforcement Profile permitting only `document.read` on a
`document` owned by the acting principal. The current authority record has a
monotonic revision and effective lifecycle. Unknown actions, kinds, relations,
profiles, bindings, signatures, or lifecycle states deny.

The verifier checks the Mandate against trusted local issuer key material,
expected issuer namespace, key ID, and fingerprint. This is local key
consistency in the POC—not an independent external issuer registry, KMS, HSM,
or workload identity system.

### Resource boundary and audit

`GET /v1/documents/:resourceId` verifies the Passport before catalog lookup,
loads current authority, derives `document.read` from the route, and derives
owner/kind from the Resource Catalog. Only an allow can call the separate
protected-content provider.

Each rate-limiter-admitted request with a syntactically valid resource ID records
two types of fact:

- `AuthorizationDecision`: Human, Agent, action, resource, allow/deny, reason,
  Mandate ID/revision, and safe Passport commitment.
- `ResourceOutcome`: `attempting`, `succeeded`, `failed`, or `not_attempted`.

The decision and first outcome are written before provider access. Audit failure
fails closed. The content file contains random per-deployment mock canaries and
is not mounted into the Runtime.

### Supported Runtime boundary

The trusted Fastify process runs on the host. Every real Codex turn runs in a
disposable Docker/Podman container with only that Agent's workspace and Codex
home mounted. The Runtime receives a scoped Ark key, Passport, and Gateway URL;
it does not receive control-plane state, signing keys, or the protected-content
file.

Host `local-process` and any all-in-one deployment co-locate trusted state and
untrusted Agent execution. They are explicitly unsupported for security claims.
No public/cloud deployment has been verified.

### Safe fresh rehearsal

Fresh rehearsal never reactivates a revoked Mandate. It compare-and-sets the
current record to a linked revoked predecessor, creates a linked active
successor, atomically repoints the seeded Agent, invalidates the old Passport
session, clears its Codex thread reference, and retains historical Runs/audit.
The UI derives the proof phase only from current-successor evidence.

## Technology stack

| Layer | Technology |
| --- | --- |
| Real Agent Runtime | Codex CLI + Volcengine Ark |
| Trusted control plane / Gateway | Node.js 22+, TypeScript, Fastify |
| Demo UI | React 19, Vite |
| Credentials / commitments | Compact JWS, Ed25519, SHA-256 |
| Mandate primitives | Competition-authored, closed `@principallatch/core` package |
| Validation / tests | Zod, Vitest, real Fastify injection |
| Supported local isolation | One disposable Docker/Podman container per turn |

## Three-minute demo outline

1. Show Alice, `agent:alice-researcher`, and the trusted boundary.
2. Run the exact Turn 1 prompt with real Codex/Ark.
3. Show Alice allow/success and Bob backend deny/not-attempted/zero successes.
4. Revoke the current Mandate while Passport TTL remains positive.
5. Run Turn 2 with the same Passport commitment/`jti`.
6. Show lifecycle deny/not-attempted and proof phase `complete`.

See [DEMO_SCRIPT.md](DEMO_SCRIPT.md),
[ARCHITECTURE_ONE_PAGE.md](ARCHITECTURE_ONE_PAGE.md), and the judge-ready
[one-page PDF](../output/pdf/PrincipalLatch_Architecture_One_Page.pdf).

## Pre-existing work and competition delta

The standalone repository began from organizer CodeJam commit
`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`. The competition-scoped
`@principallatch/core` package was authored for this entry; no prior personal
identity/delegation package is vendored or declared as a dependency.

Competition work is the product integration: Human/Agent ownership, short-lived
Agent Passports, current signed authority and revocation, constrained policy
commitment, resource Gateway/provider separation, decision/outcome audit, safe
Runtime injection and per-Agent mounts, current-evidence UI, successor rehearsal,
negative tests, and delivery materials. Full disclosure is in
[../PREEXISTING.md](../PREEXISTING.md).

## Limitations disclosed to judges

- Alice is a fixture session, not an authenticated production user. Bob has no
  browser login and exists as the server-side negative-control resource owner.
- Single-process JSON state/audit is not a transactional, append-only,
  high-availability, or rollback-resistant authority database.
- The per-IP Gateway limiter is process-local and resets on restart; there is no
  distributed abuse control, egress allowlist, KMS/HSM, independent trust root,
  key rotation, sender-constrained token, or workload attestation.
- Authorized mock content may persist in Agent output, application messages,
  workspace, and per-Agent Codex state.
- Container/host administrators can inspect Runtime state; application redaction
  is not proof about external logs or telemetry.
- The Runtime has outbound access for Ark and the Gateway. Ordinary containers
  are a hackathon boundary, not hostile multi-tenant isolation.
- The deterministic `npm run verify:demo` path uses no model and cannot replace
  the official real Agent Run.

## Final evidence gates

### Code and reproducibility

- [ ] Record the submitted commit SHA and confirm the working tree is clean.
- [ ] `npm ci` succeeds from a fresh checkout.
- [ ] `npm run check` passes on the submitted commit; save complete output.
- [ ] `npm run verify:demo` passes and reports
      `middleware-verification-no-model` / `liveAgentRun=false`.
- [ ] `npm audit --omit=dev` has no unresolved high/critical finding, or each
      remaining finding is accurately disclosed.
- [ ] Review committed files and captured application output for Ark/app tokens,
      signing seeds, raw Passports, and generated canaries.

### Official live proof

- [ ] Start the security-supported profile with `npm run poc`.
- [ ] A real Codex + Ark Turn 1 produces Alice allow/success and Bob backend
      deny/not-attempted with zero Bob successes.
- [ ] Revocation plus real Turn 2 produces a same-Passport lifecycle denial while
      TTL remains positive.
- [ ] Capture final Run IDs, commit SHA, model endpoint label, engine, timestamp,
      Passport commitments, and audit screenshots without exposing secrets.
- [ ] Rehearse and record the final real-Agent demo at three minutes or less.
- [ ] Verify the exported video is at most `03:00`, contains English narration
      or English captions, and exposes no secret, raw Passport, or mock content.
- [ ] Upload the final video to YouTube as **Public** and verify anonymous
      playback from its Devpost URL.

### Delivery

- [ ] Make the candidate repository public and verify anonymous clone/read:
      **https://github.com/hnaymyh123-henry/principallatch-techjam** (currently
      private).
- [ ] Add final submitted commit: **pending**.
- [x] Export/verify the one-page architecture artifact (one-page PDF plus PNG;
      visually checked after Poppler rendering).
- [ ] Add the public YouTube demo URL and verify it plays without login:
      **pending**.
- [ ] Verify the public repository provides a free test build/path for judges:
      `npm run verify:demo` without credentials and the documented `npm run poc`
      real-Agent path with a scoped Ark credential.
- [ ] Do not claim public cloud unless a separately isolated deployment and
      fresh end-to-end smoke test are actually completed.
