# Security policy

PrincipalLatch is a competition proof of concept for **TikTok TechJam 2026 —
Track 1: Bouncer**. It demonstrates a server-enforced authorization boundary
for generated mock data. It is not a production identity provider, policy
service, or hardened multi-tenant sandbox.

Only the latest revision on the submission branch is supported.

## Supported trust boundary

The security-supported profile has two trust domains:

1. A trusted host process runs Fastify, Agent ownership, Passport and Mandate
   signing, current authority, the Resource Catalog, protected-content provider,
   and JSON audit/state storage.
2. Each untrusted real Codex turn runs in a disposable Docker/Podman container.
   It receives only that Agent's workspace, that Agent's Codex home, the scoped
   model API key, the current short-lived Agent Passport, and the Gateway URL.

Run this profile with `npm run poc`. The Runtime receives no mount of the
repository, control-plane data directory, signing-key directory, or
protected-content file.
The Passport-only `/v1` Gateway is its supported resource path.

`RUNTIME_PROVIDER=local-process` is an explicitly insecure development preview.
The Agent shares the trusted process's OS account and can read its files. Any
all-in-one profile similarly co-locates the Agent process with trusted state.
Such profiles are not shipped as PrincipalLatch judging paths and may not support
isolation or backend-enforcement claims. No public/cloud deployment has been
verified.

## Threat model

The proof assumes the Agent may follow a hostile prompt and request a resource
outside the acting principal's scope. PrincipalLatch must reject that request from
server-owned facts before Bob's protected provider is called. It also assumes a
captured but still-valid Passport must stop working when its Agent session ends
or its current Mandate is revoked.

The trusted host account, Fastify process, local JSON store, container-engine
administrator, and configured model provider are outside this adversary model.
Compromise of those components defeats the POC boundary.

## Implemented controls

- Alice and Bob are separate server-side principal fixtures. The seeded Agent
  is `agent:alice-researcher`, owned by `user:alice`.
- The browser uses a shared operator token plus an opaque `HttpOnly`,
  `SameSite=Strict` Alice demo session. Human mutations require an allowed
  origin and CSRF token. The fixture session is not production authentication;
  Bob has no browser login path.
- Non-owner access to Agent control-plane objects returns `404`.
- Agent Session Passports are compact Ed25519 JWS values with an exact header,
  strict claims, fixed issuer/audience/key ID, a maximum 300-second lifetime,
  exact Agent/Human/Mandate/session binding, and active-session validation.
- The Passport contains identity context, not roles, permissions, or resource
  IDs. Ending/deleting an Agent, or starting a fresh rehearsal, invalidates its
  cached Passport session.
- A separately signed current Mandate binds `principal × agent`, lifecycle,
  revision, and the canonical Enforcement Profile commitment. Verification
  checks consistency with the trusted local issuer key, key ID, fingerprint,
  and expected issuer namespace. There is no independent external issuer pin.
- The Runtime cannot supply a Mandate body, URL, or revision. The Gateway loads
  the current authority record and evaluates its effective lifecycle on every
  request.
- `document.read` comes from the route; resource kind and owner come from the
  trusted Resource Catalog. Agent-supplied authorization attributes are ignored.
- Passport validation happens before resource lookup. A decision plus
  `ResourceOutcome=not_attempted` is persisted for a deny. An allow plus
  `ResourceOutcome=attempting` is persisted before provider access; terminal
  success/failure is recorded separately. A pre-access audit failure fails
  closed without calling the provider. A terminal audit failure cannot undo an
  already attempted provider call, so the API reports the recorded
  authorization as `allow` and its outcome as `indeterminate`; the durable
  `attempting` event remains explicit rather than being rewritten as a deny.
- Protected mock content is generated randomly per data directory and stored in
  a separate trusted file. It is not a source-code fixture and is not returned
  by catalog, security-summary, or audit APIs.
- Application code does not place raw Passports in prompts, argv, Human/browser
  API responses, persisted Run credential fields, or audit records. Known
  Passport and model-key values are redacted from captured Runner output and errors.
- Passport and Mandate seed files are created exclusively and request `0600`
  mode where the platform honors POSIX permissions.
- Runtime containers use a read-only root, a constrained `/tmp`, no IPC,
  dropped capabilities, `no-new-privileges`, CPU/memory/PID limits, and only
  the selected Agent's workspace and Codex-home mounts.

## Fresh rehearsal safety

**Fresh rehearsal** never changes a revoked Mandate back to active. It performs
a compare-and-set transition that:

1. preserves and revokes the current predecessor, linking `replaced_by`;
2. creates a new active successor Mandate, linking `replaces`;
3. repoints the seeded Agent to that successor in the same store mutation;
4. invalidates the previous Passport session and resets the Agent's Codex thread
   reference; and
5. scopes the UI's current-rehearsal proof to the successor while retaining
   historical Runs and audit records.

## Known limitations

- Alice and Bob are mock personas, not authenticated accounts. The operator
  token is shared access control, not a user identity assertion.
- Agent Passports are bearer credentials. They do not attest which executable
  holds them and are not sender-constrained.
- A container-engine or host administrator can inspect process/container state.
  Application-level redaction does not prove that a raw Passport is absent from
  engine events, host telemetry, crash dumps, or third-party observability.
- The Runtime has outbound bridge-network access for TokenDance and the Gateway. There
  is no egress allowlist, proxy policy, or network-level exfiltration defense.
- Authorized Alice content is delivered to the Agent and may persist in model
  output, `principallatch.json`, the Agent workspace, or per-Agent Codex state. Only
  generated mock content is safe for this demonstration.
- `JsonStore` is single-process JSON storage. It is neither transactional across
  processes nor append-only, highly available, or resistant to rollback of the
  entire trusted state snapshot.
- The Gateway has an in-memory per-IP rate limit (120 requests/minute by
  default). It is not distributed and resets on restart. Rate-limited requests
  and syntactically invalid resource IDs do not enter the business audit.
- Local keys are not protected by KMS/HSM, rotation, independent trust roots, or
  hardware workload attestation.
- The policy supports one action (`document.read`), one resource kind
  (`document`), and one relation (`self`); it is not a general authorization DSL.
- Ordinary Docker/Podman containers are a practical hackathon boundary, not a
  hardened hostile multi-tenant sandbox. Never mount an engine socket, host
  root, personal files, or production secrets into the Runtime.
- The default local UI/Gateway uses HTTP. `SESSION_COOKIE_SECURE=true` requires a
  trusted HTTPS reverse proxy before any non-demo exposure.

## Safe operation

- Use only `npm run poc` for the judged security demonstration.
- Use a scoped, revocable competition model key and a unique 24+ character
  URL-safe `APP_AUTH_TOKEN`.
- Keep the trusted data directory and container-engine API inaccessible to the
  Runtime. Inspect and remove residual labelled Runtime containers after a
  crash.
- Use only generated mock documents. Never place personal, payroll, customer,
  or production content in this POC.
- Stop the POC and revoke the model key after the event.

### Post-competition data deletion

The official rules require all data used or processed to be deleted when the
competition is complete. After judging and any required verification period:

1. stop `npm run poc` and confirm no containers carrying the
   `io.codejam.principallatch=agent-runtime` label remain;
2. revoke the scoped model key and remove any local shell/session copies of the
   operator token;
3. delete `.local/` or the configured `LOCAL_POC_DATA_ROOT`, including JSON
   state, audit records, generated mock canaries, workspaces, and Codex home;
4. delete non-submitted raw recordings, screenshots, console captures, and
   provider/engine logs that contain Run data or mock content where retention
   is under the entrant's control; and
5. retain only the public source and final submission artifacts required for
   judging, prize verification, and the licenses that apply to them.

## Report a vulnerability

Send the repository owner or organizer the affected commit, reproduction steps,
impact, and suggested mitigation. Do not publish credentials, raw Passports,
signing seeds, personal data, or exploit details in a public issue.
