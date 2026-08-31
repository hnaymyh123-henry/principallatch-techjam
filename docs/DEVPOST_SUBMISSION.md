# PrincipalLatch — Devpost submission fields

This document contains English copy for the TikTok TechJam 2026 Devpost entry.
It is intentionally honest about the supported local trust boundary and must not
be submitted until the final commit, public repository, and public YouTube demo
fields are complete.

## Project name

**PrincipalLatch**

## Tagline

A backend Bouncer that separates an AI Agent's identity from its human's
revocable authority.

## Short pitch

Most Agent platforms authenticate the human and then let the Agent inherit that
human's ambient credentials. PrincipalLatch treats the Agent as a separate actor.
It gives each Runtime session a short-lived signed Passport, then evaluates the
human's current signed Mandate at the protected resource boundary before any
private content is read.

## Inspiration

An autonomous Agent can be correctly identified and still be unauthorized for
the action it is attempting. Human login answers who opened the application; it
does not answer which Agent process is calling a backend, which human it acts
for, or whether that authority was revoked after the Agent session began.

Prompt instructions are not an authorization boundary. The model can ignore
them, and the prompt must not be allowed to decide resource ownership. We built
PrincipalLatch around a simple principle: **identity says who is acting; a current
Mandate says what that actor may still do**.

## What it does

The demo has one browser user, Alice, one Agent principal owned by Alice, and
Bob as an independent server-side resource owner used as a negative control.

1. The trusted control plane issues Alice's Agent a short-lived Ed25519 Agent
   Session Passport.
2. The real Codex Agent requests Alice's mock document through the protected
   document client. The backend verifies identity and current authority, records
   `ALLOW_SCOPE_RULE`, and only then calls the content provider.
3. The same Agent requests Bob's mock document. The backend returns
   `403 DENY_OWNER_MISMATCH`; the provider is not called and Bob's successful
   read count remains zero.
4. Alice revokes the signed Mandate without rotating the still-valid Passport.
5. A second real Agent turn reuses the same Passport commitment and is denied
   even Alice's document with `DENY_MANDATE_LIFECYCLE`.

Every admitted request records the Human, Agent, action, resource, decision,
reason, Mandate revision, safe Passport commitment, and provider outcome.

## How we built it

PrincipalLatch extends the organizer's Agent Starter Kit while preserving its
React/Fastify control plane and Codex CLI + Volcengine Ark Runtime path.

- **Agent identity:** compact Ed25519 JWS Passports bind the Human principal,
  Agent principal, Runtime session, Mandate ID, audience, issue time, expiry,
  and unique token ID. A Passport contains identity context, not permissions.
- **Delegated authority:** the competition-authored `@principallatch/core` package
  defines a strict signed Mandate, deterministic encoding, key commitments,
  lifecycle classification, and a closed `document.read × document × self`
  enforcement profile.
- **Backend enforcement:** Fastify derives the action from the HTTP route and
  ownership from a trusted Resource Catalog. It revalidates the current Mandate
  immediately before provider access and fails closed on unknown or stale state.
- **Trust boundary:** the control plane, signing material, resource catalog, and
  protected mock canaries stay on the trusted host. Each real Codex turn runs in
  a fresh non-root Docker/Podman container with only that Agent's workspace and
  Codex home mounted.
- **Evidence:** authorization decisions and resource outcomes are persisted
  separately. The UI derives demo completion from current audit evidence rather
  than from a client-controlled animation.

## Technical challenges

The hardest problem was proving that denial happened before content access, not
merely showing a model that politely refused. We separated the Resource Catalog
from the protected-content provider and audit both the policy decision and the
provider outcome. Bob's `not_attempted` outcome and zero successful reads are
therefore backend evidence.

Revocation also introduced a time-of-check/time-of-use problem. PrincipalLatch
serializes revocation and admission for a Mandate, then reloads and verifies the
current signed authority immediately before provider access. A regression test
forces revocation to win that race and proves the provider remains untouched.

Finally, the Runtime receives credentials, so cancellation and cleanup had to be
fail-closed. The launcher rejects root Runtime identities, prevents workspace
path relocation and symlink/junction escapes, limits mounts and resources, and
verifies that cancelled credential-bearing containers are removed.

## Accomplishments

- The official User A allow and User B backend-deny story is implemented at the
  actual resource boundary rather than in the UI or prompt.
- Revocation takes effect against the same unexpired Agent identity, separating
  authentication from current authority in a way that is visible to judges.
- Automated tests cover signature, binding, lifecycle, profile, ownership,
  audit, session isolation, race, cancellation, mount, and secret-redaction
  failures.
- The repository contains a reproducible one-page trust-boundary diagram,
  deterministic no-model Gateway verifier, and a timed real-Agent demo script.

## What we learned

Agent identity is necessary but insufficient. A trustworthy Agent Runtime needs
three independently verifiable facts: the human principal, the executing Agent
principal, and the authority that is current for this action and resource. It
also needs outcome evidence below the policy layer; an `allow` event alone does
not prove that a provider was or was not called.

## What's next

The hackathon POC intentionally uses single-node JSON state and local signing
keys. A production version would move authority and audit state to a
transactional store, use managed keys with rotation, add workload attestation
and sender-constrained credentials, enforce an egress allowlist, and expose the
same boundary as reusable HTTP/MCP middleware for multiple Agent runtimes.

## Development tools, APIs, assets, and libraries

- **Development tools:** TypeScript, Node.js 22, npm workspaces, Codex CLI,
  Docker/Podman, and GitHub Actions.
- **APIs:** the Volcengine Ark OpenAI-compatible Responses API and
  PrincipalLatch's competition-authored Fastify HTTP Gateway.
- **Assets:** the UI, favicon, architecture diagram, and generated mock
  document canaries were authored for this entry. No third-party media or
  personal/production data is included.
- **Libraries:** Fastify, React 19, Vite, Zod, Vitest, `@noble/ed25519`, and
  standard Node.js cryptography. Direct dependencies retain their upstream
  licenses; the organizer scaffold and PrincipalLatch code are disclosed in
  [`PREEXISTING.md`](../PREEXISTING.md) and [`LICENSE`](../LICENSE).

## Testing instructions

The supported security demo is local because the official Track 1 guide makes
local container execution the default and cloud deployment optional.

### Credential-free middleware verification

```bash
git clone https://github.com/hnaymyh123-henry/principallatch-techjam.git
cd principallatch-techjam
npm ci
npm run check
npm run verify:demo
```

`verify:demo` exercises the real Fastify Gateway, signed Passport/current
Mandate checks, Alice allow, Bob backend denial, provider-call gating, audit,
and revocation. It explicitly reports `liveAgentRun=false`; it is not presented
as the required live-Agent demonstration.

### Real Agent demonstration

Install Node.js 22+ and Docker/Podman, then provide a scoped Volcengine Ark key,
a Responses-compatible endpoint/model ID, and an independently generated
operator token:

```bash
ARK_API_KEY=... \
ARK_MODEL=... \
APP_AUTH_TOKEN=at-least-24-url-safe-characters \
npm run poc
```

Open `http://localhost:3000`, enter the operator token, continue as Alice,
select **Alice Research Agent**, and choose **Fresh rehearsal**. The exact timed
sequence is in [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md).

Only generated mock documents are used. Never use production data or commit a
credential.

## Submission links and final evidence

- Public repository: **pending public visibility** —
  `https://github.com/hnaymyh123-henry/principallatch-techjam`
- Final submitted commit: **pending**
- Public YouTube demo, `03:00` or shorter: **pending**
- One-page architecture:
  [`PrincipalLatch_Architecture_One_Page.pdf`](../output/pdf/PrincipalLatch_Architecture_One_Page.pdf)
- Originality and prior-work disclosure: [`PREEXISTING.md`](../PREEXISTING.md)
- Final evidence checklist: [`SUBMISSION.md`](SUBMISSION.md#final-evidence-gates)
