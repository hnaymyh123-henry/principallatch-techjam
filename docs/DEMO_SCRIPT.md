# PrincipalLatch — three-minute live demo

This is the operator cue card for **TikTok TechJam 2026 — Track 1: Bouncer**.
The primary proof uses real Codex CLI turns connected to TokenDance's Responses API. A test,
HTTP verifier, or recorded artifact must never be described as a live Agent Run.

## One-sentence story

Alice delegates to `agent:alice-researcher`; the trusted backend allows that
Agent to read Alice's resource, denies Bob's resource before content access,
then immediately honors Alice's Mandate revocation even though the Agent's
Passport is still valid.

Bob is the official negative-control User B and a server-side resource owner.
Alice is the only browser session; Bob has no browser login, Agent Runtime, or
Agent. Both identities are mock fixtures, not production authentication.

## Success criteria

The camera must show:

1. a real containerized Codex/TokenDance Run;
2. `alice-doc-001 → ALLOW_SCOPE_RULE → succeeded`;
3. `bob-payroll-001 → DENY_OWNER_MISMATCH → not_attempted`, with Bob's audited
   successful reads still `0`;
4. an audit row containing Human, Agent, `document.read`, resource, and decision;
5. Alice revoking the current Mandate;
6. a second real Run using the same `jti` and Passport SHA-256 commitment while
   TTL remains positive; and
7. `alice-doc-001 → DENY_MANDATE_LIFECYCLE → not_attempted` after revocation.

Items 1–4 are the core official Bouncer proof. Items 5–7 are PrincipalLatch's
additional revocable-delegation proof.

## Before the judging timer

- [ ] Use the final clean commit and the supported `npm run poc` profile.
- [ ] Confirm the sidebar says a container Runtime and shows the configured TokenDance
      model/engine. There must be no red **Insecure Runtime preview** banner.
- [ ] Run `npm run check` and save its fresh output.
- [ ] Run `npm run verify:demo` and retain its output, while remembering that it
      reports `middleware-verification-no-model` / `liveAgentRun=false`.
- [ ] Enter the operator token, click **Continue as Alice**, and select
      **Alice Research Agent**.
- [ ] Click **Fresh rehearsal** and confirm. Verify the UI shows an active new
      successor Mandate and proof phase `ready turn 1`.
- [ ] Confirm no Run is active and the **Fill Turn 1** button is enabled. The
      Passport will be issued when Turn 1 starts, so do not wait for it first.
- [ ] Close terminals or panels that could expose `MODEL_API_KEY`, app token,
      signing files, the raw Passport, or generated document content.
- [ ] Rehearse against the actual TokenDance endpoint. The two Runs and narration must
      complete before the 300-second Passport lifetime and three-minute limit.

Fresh rehearsal does not erase history or reactivate a revoked Mandate. It
revokes/links the predecessor, issues a new active successor, invalidates the
old Agent session, clears the stored Codex thread reference, and scopes the
visible proof to the successor.

## Exact sequence

| Time | Action on screen | Spoken line |
| --- | --- | --- |
| **0:00–0:18** | Show the trust-flow row: `user:alice → agent:alice-researcher → PrincipalLatch → Alice + Bob docs`. | “This is Bouncer middleware, not two users sharing one Agent. Alice owns one Agent. Bob is the independent resource owner used to test the boundary.” |
| **0:18–0:30** | Point to **Human session**, **Agent principal**, active signed Mandate, and “Passport issued on first run.” | “Alice is the only browser session. Bob is only a server-side resource owner. The Agent is a separate principal; its short-lived Passport identifies the session while the current Mandate supplies revocable authority.” |
| **0:30–0:38** | Click **Fill Turn 1**, then **Run**. | “This launches the real Codex Runtime. The prompt asks for both IDs, but it does not contain a credential, owner, or decision.” |
| **0:38–1:22** | While the real Run executes, point to the Gateway and resource cards. | “Fastify verifies the Passport, loads current authority, derives the action from the route and ownership from its own catalog, then audits before touching content.” |
| **1:22–1:48** | Show the completed Run and the two Gateway rows. Highlight Alice `succeeded`, Bob `not attempted`, and Bob successes `0`. | “Alice succeeds. Bob receives a backend 403. This is not the model politely refusing—the protected provider was never called.” |
| **1:48–2:00** | Point to the Passport commitment, `jti`, positive TTL, and current Run ID. Then click guided **Revoke** and confirm. | “Now Alice removes delegated authority. I am deliberately not rotating the Agent identity.” |
| **2:00–2:08** | Show Mandate `revoked` and proof phase `ready turn 2`; click **Fill Turn 2**, then **Run**. | “The next request must consult current authority rather than trust stale permission.” |
| **2:08–2:40** | Let the second real Run execute; use the wait to point to the one-page architecture. | “The Runtime still holds the same unexpired Passport, but the trusted host owns lifecycle state.” |
| **2:40–2:55** | Show `DENY_MANDATE_LIFECYCLE / not attempted`; compare both Run rows' Passport SHA-256 and `jti`. | “Identity is still valid; authority is gone. Revocation takes effect before another content read.” |
| **2:55–3:00** | End on proof phase `complete` and the audit table. | “PrincipalLatch makes a general Agent Runtime a verifiable, revocable delegated actor.” |

If actual TokenDance latency differs, move explanation into the wait periods; never
skip either real Run or speak past three minutes.

## Exact prompts

Turn 1 is filled by the UI:

> Boundary test: first read `alice-doc-001`, then attempt
> `bob-payroll-001`. Call the protected document client for both IDs and report
> each exact gateway result.

Turn 2 is filled by the UI:

> Revocation test: using this same Agent session, try `alice-doc-001` again
> through the protected document client and report the exact gateway result.

Do not paste a Passport or secret into either prompt.

## What the proof means

- The model's response is not the authorization evidence; the Gateway audit is.
- Bob's `not_attempted` outcome and zero audited successes show enforcement
  before private-provider access.
- The two Run rows' matching `jti` and Passport SHA-256 commitment prove the
  same application-issued credential was reused; the raw JWS is not shown.
- A positive TTL rules out token expiry as the reason for Turn 2 denial.
- Proof phase `complete` is derived from current-Mandate audit evidence, not a
  manually advanced slide or client-only state.

## Honest failure path

If Docker/Podman, Codex, or TokenDance fails during judging:

1. keep the failed Run ID, time, and exact error visible; do not claim success;
2. run `npm run verify:demo` and show the fresh Alice/Bob/revocation middleware
   result;
3. state explicitly: “This is a no-model HTTP integration proof and does not
   replace the official live-Agent requirement”; and
4. optionally show a prior successful artifact labelled **recorded evidence**
   with its commit and timestamp.

Never edit `principallatch.json`, re-seed fabricated audit rows, switch to
`local-process`, or use an all-in-one deployment profile to make a failed live
demo look successful.
