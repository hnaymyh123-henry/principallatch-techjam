# Prior work and originality disclosure

PrincipalLatch is a standalone entry for **TikTok TechJam 2026 — Track 1:
Bouncer**. This file separates the organizer scaffold and standard third-party
libraries from work authored for this submission.

## Organizer starting point

The application scaffold began from organizer CodeJam commit
[`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`](https://github.com/RrankPyramid/CodeJam/commit/8d0bd4f14ad1e453d984149aebcdd0bcb4f74178).
It supplied the React/Fastify Agent playground, JSON storage, workspaces, Codex
Runner, local container option, and optional cloud examples. It did not supply
Track 1 Human/Agent identity, delegation, resource authorization, revocation,
or decision audit middleware.

The submitted code is intentionally maintained as a new `principallatch-techjam`
repository with its own product name and history. Reviewers should use the
organizer commit link above as the scaffold reference; this repository does not
pretend that the scaffold itself was newly invented.

## Competition-authored PrincipalLatch work

The entry adds:

- Alice and Bob server-side principal fixtures, exact Agent ownership, and an
  Alice-only browser session for the official cross-user negative control;
- a short-lived Ed25519 Agent Session Passport bound to Human, Agent, Runtime
  session, and current mandate ID;
- the competition-scoped `@principallatch/core` package: a new closed signed
  mandate schema, deterministic encoding, issuer-key commitments, Ed25519
  sign/verify helpers, and lifecycle classification;
- current signed authority with monotonic revision, revocation, successor
  issuance, profile commitment, and request-time revalidation;
- the `/v1` resource gateway, trusted Resource Catalog, separately stored mock
  canaries, provider-call gating, and decision/outcome audit trail;
- per-turn disposable Runtime isolation, per-Agent mounts, secret separation,
  cancellation/cleanup hardening, and cross-platform launchers;
- the Bouncer UI, deterministic HTTP verifier, security regression suite,
  architecture artifact, demo script, and submission checklist.

`packages/principallatch-core` was authored for this entry and is deliberately
small. No code from a prior personal identity/delegation repository is vendored,
copied as a package, or declared as a dependency.

Earlier personal research explored signed principal-to-Agent delegation as a
problem area. PrincipalLatch does not reuse that project's source, package,
repository history, or product name. The competition-specific contribution is
the Runtime Passport integration, request-time current-authority check,
resource Gateway and provider-call proof, same-identity revocation sequence,
disposable Runtime boundary, and judge-facing verification workflow.

## Standard components we do not claim as inventions

PrincipalLatch does not claim ownership of the organizer scaffold, Codex CLI,
TokenDance, DeepSeek, Ed25519, SHA-256, compact JWS, React, Fastify, Zod, Vitest,
Docker, or Podman. The original contribution is the concrete runtime-security
integration and proof workflow, not the underlying cryptographic algorithms or
frameworks.

We also do not claim:

- production authentication for the Alice/Bob fixtures;
- an independent PKI, KMS/HSM, workload attestation, or hardened multi-tenant
  sandbox;
- public/cloud deployment without a separate verified trust-domain design; or
- `npm run verify:demo` as the required live Agent Run—it explicitly reports a
  deterministic no-model middleware verification.

## Final disclosure checklist

- [ ] Record the submitted repository URL and commit SHA.
- [ ] Confirm a fresh clone passes `npm ci` and `npm run check`.
- [ ] Compare the submitted tree with the competition-authored list above.
- [ ] Keep live-run and deployment claims synchronized with
      `docs/SUBMISSION.md`.
- [ ] Scan the committed tree for API keys, signing seeds, raw Passports, and
      generated mock canaries.
