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
| Demonstrate a real Agent Run | The primary judging path uses Codex CLI in a disposable Runtime container with TokenDance and `deepseek-v4-flash-0731`. Final live evidence remains a submission gate. |
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

The decision and first outcome are written before provider access. A failure of
that pre-access write fails closed. If only the terminal outcome write fails
after a provider attempt, the API preserves the recorded `allow` and returns an
`indeterminate` outcome rather than misreporting a denial. The content file
contains random per-deployment mock canaries and is not mounted into the
Runtime.

### Supported Runtime boundary

The trusted Fastify process runs on the host. Every real Codex turn runs in a
disposable Docker/Podman container with only that Agent's workspace and Codex
home mounted. The Runtime receives a scoped model key, Passport, and Gateway URL;
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
| Real Agent Runtime | Codex CLI + TokenDance Responses API |
| Trusted control plane / Gateway | Node.js 22+, TypeScript, Fastify |
| Demo UI | React 19, Vite |
| Credentials / commitments | Compact JWS, Ed25519, SHA-256 |
| Mandate primitives | Competition-authored, closed `@principallatch/core` package |
| Validation / tests | Zod, Vitest, real Fastify injection |
| Supported local isolation | One disposable Docker/Podman container per turn |

## Three-minute demo outline

1. Show Alice, `agent:alice-researcher`, and the trusted boundary.
2. Run the exact Turn 1 prompt with real Codex/TokenDance.
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
- The Runtime has outbound access for TokenDance and the Gateway. Ordinary containers
  are a hackathon boundary, not hostile multi-tenant isolation.
- The deterministic `npm run verify:demo` path uses no model and cannot replace
  the official real Agent Run.

## Final evidence gates

### Code and reproducibility

- [x] Record the submitted commit SHA and confirm the working tree is clean.
      Runtime evidence commit:
      `2e85d9d14b4b6033f65a9fc449955183cbbb794e`
      ("Adopt TokenDance Responses provider for the isolated Codex Runtime").
      The delivery commit that adds this checklist update and the demo-video
      assets follows it on `main`; after that commit the working tree is clean
      except intentionally untracked internal handoff notes.
- [x] `npm ci` succeeds from a fresh checkout (clean-room anonymous clone of
      `2e85d9d`, 2026-09-01; install completed with `0` vulnerabilities).
- [x] `npm run check` passes on the submitted commit (clean-room clone of
      `2e85d9d`, 2026-09-01: core tests `6/6`, server tests `77/77`, web
      tests `2/2`, launcher tests `5/5`, typechecks and production builds,
      `30` local links across `13` Markdown files).
- [x] `npm run verify:demo` passes and reports
      `middleware-verification-no-model` / `liveAgentRun=false`
      (`auditEvents=7`, `bobProviderReads=0`).
- [x] `npm audit --omit=dev --audit-level=high` reported `0` vulnerabilities.
- [x] Review committed files and captured application output for model/app
      tokens, signing seeds, raw Passports, and generated canaries
      (repository scans on `2e85d9d` plus a full-length 17-frame visual sweep
      of the final demo video on 2026-09-01 found none).

### Official live proof

- [x] Start the security-supported profile with `npm run poc`
      (WSL2 rootless Podman `5.8.6` profile, 2026-09-01).
- [x] A real Codex + TokenDance Turn 1 produces Alice allow/success and Bob
      backend deny/not-attempted with zero Bob successes
      (Run `9ab7d9b3-6995-41b3-973d-008772856894`; mandate successor
      `3c48ed1a-2696-4ccc-b558-2d89f412237b`; verified against persisted
      state: `DENY_OWNER_MISMATCH`, Bob provider reads `0`).
- [x] Revocation plus real Turn 2 produces a same-Passport lifecycle denial
      while TTL remains positive
      (Run `8cf167b1-979d-4895-afbe-26baeb3944d0`,
      `DENY_MANDATE_LIFECYCLE / not_attempted`, mandate `status=revoked`,
      `samePassportActive=true`).
- [x] Capture final Run IDs, commit SHA, model endpoint label, engine,
      timestamp, Passport commitments, and audit screenshots without exposing
      secrets (TokenDance Responses / `deepseek-v4-flash-0731`; only safe
      commitment/`jti` references and decision metadata appear in evidence).
- [x] Rehearse and record the final real-Agent demo at three minutes or less
      (`PrincipalLatch_TechJam_Demo_2m55s.mp4`, 1920x1080 @ 30 fps, `2:55`).
- [x] Verify the exported video is at most `03:00`, contains English narration
      or English captions, and exposes no secret, raw Passport, or mock
      content (`ffprobe`: h264 + aac, `175.08` s; full-length 17-frame visual
      sweep clean; corrected 40-cue English SRT sidecar at
      [`output/demo/PrincipalLatch_Demo_EN_final.srt`](../output/demo/PrincipalLatch_Demo_EN_final.srt)).
- [ ] Upload the final video to YouTube as **Public** and verify anonymous
      playback from its Devpost URL. — pending user-authorized upload.

### Delivery

- [x] Make the candidate repository public and verify anonymous clone/read:
      **https://github.com/hnaymyh123-henry/principallatch-techjam**
      (public since 2026-09-01; anonymous page/API access and anonymous
      `git clone` verified against `2e85d9d`).
- [ ] Add final submitted commit: runtime evidence commit
      `2e85d9d14b4b6033f65a9fc449955183cbbb794e` plus the delivery commit on
      `main`; the Devpost entry must reference the `main` HEAD at submission
      time. — pending final submission.
- [x] Export/verify the one-page architecture artifact (one-page PDF plus PNG;
      visually checked after Poppler rendering).
- [ ] Add the public YouTube demo URL and verify it plays without login:
      **pending user-authorized upload**.
- [x] Verify the public repository provides a free test build/path for judges:
      `npm run verify:demo` without credentials (verified on a clean-room
      anonymous clone) and the documented `npm run poc` real-Agent path with a
      scoped model credential.
- [x] Do not claim public cloud unless a separately isolated deployment and
      fresh end-to-end smoke test are actually completed. (No public cloud
      deployment is claimed anywhere in the submission copy.)

### Post-competition

- [ ] After judging and any required verification period, revoke the scoped model
      key and follow the data-deletion procedure in
      [`SECURITY.md`](../SECURITY.md#post-competition-data-deletion).
