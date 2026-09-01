# PrincipalLatch — 2:55 competition demo video

This is the final recording and edit plan for the TikTok TechJam Track 1
submission. The deliverable is a 16:9, 1080p, 30 fps video with Frederick
English narration and burned-in English captions. Final timeline duration:
**2 minutes 55 seconds**. No background music is used.

## Editorial thesis

Do not present PrincipalLatch as a chatbot or as two users sharing one Agent.
The story is one human owner, one delegated Agent principal, and one independent
resource owner used as a negative control. The proof is the Gateway audit, not
the model's prose.

## Timeline

| Time | Picture | English narration |
| --- | --- | --- |
| 0:00–0:07 | Clean title card: PrincipalLatch, Track 1 — Bouncer. | “PrincipalLatch makes a general AI Agent a verifiable and revocable delegated actor.” |
| 0:07–0:23 | Product dashboard and trust-flow row. | “An Agent Runtime may have a model and tools, but that does not prove who launched it, what it may access, or whether that authority is still valid.” |
| 0:23–0:40 | Highlight Alice, her Agent, and Bob's document. | “Alice is the only signed-in user. She owns one research Agent. Bob is not a second tenant or teammate; he is the independent resource owner used to test the authorization boundary.” |
| 0:40–0:58 | Animate Human → Agent → Mandate/Passport → Gateway. | “The trusted host issues a short-lived Agent Passport for session identity and a signed Mandate for authority. Every resource request is checked again at the Gateway.” |
| 0:58–1:19 | Show recorded Turn 1 with Codex/TokenDance/Podman labels, then Alice result. | “In this recorded run, a real Codex Agent executed through TokenDance inside a disposable rootless Podman container. The prompt supplied resource IDs, but no credential, owner, or authorization decision. Alice's document was allowed.” |
| 1:19–1:40 | Show Bob `403`, `DENY_OWNER_MISMATCH`, `not_attempted`, reads `0`. | “The same Agent then requested Bob's document. The backend derived ownership from its trusted catalog and returned HTTP 403 with `DENY_OWNER_MISMATCH`. The protected provider was not attempted, and Bob's successful read count remained zero.” |
| 1:40–1:56 | Zoom to the recorded audit evidence. | “The audit joins the Human principal, Agent principal, action, resource, rule, decision, and provider outcome. This evidence comes from middleware enforcement, not from model prose.” |
| 1:56–2:10 | Show positive Passport TTL and commitment; revoke the Mandate. | “Alice then revoked the signed Mandate. The Agent identity, session, and Passport commitment deliberately remained unchanged.” |
| 2:10–2:34 | Show recorded Turn 2; compare Passport `jti`/SHA, then lifecycle denial. | “Recorded turn two reused the same Agent session, Passport JTI, and SHA-256 commitment. But current authority was gone. The Gateway returned `DENY_MANDATE_LIFECYCLE` before another content read. Identity was still valid. Permission was not.” |
| 2:34–2:50 | One-page architecture and portability callout. | “PrincipalLatch is model-independent runtime middleware: a trusted control plane, signed delegation, boundary enforcement, and auditable outcomes. TokenDance powers this demo, while the authorization design stays portable.” |
| 2:50–2:55 | End card and repository URL. | “PrincipalLatch: portable authority, immediate revocation.” |

## Recording rules

- Start recording only after the operator-token screen is complete.
- Never show `MODEL_API_KEY`, the operator token, a raw Passport, environment
  variables, terminal history, or protected document content.
- Use **Fresh rehearsal** immediately before the take.
- Keep the container Runtime, TokenDance model label, Run IDs, Gateway decisions,
  Passport commitment, and audit rows visible long enough to read.
- If a live provider call fails, label any prior run as **Recorded evidence**.
  Never edit or replay a failed run as if it were live.
- Use direct cuts and restrained zooms. Avoid decorative B-roll, background
  music, or transitions that compete with the evidence.

## Caption style

- English, sentence case, two lines maximum.
- White semibold text on a 75% black rounded background.
- Bottom-safe placement with at least 80 px margin at 1080p.
- Highlight the denial codes (`DENY_OWNER_MISMATCH`,
  `DENY_MANDATE_LIFECYCLE`) in red.
- Burn captions into the submission video and also export the `.srt` sidecar.

## ChatCut production state

- Project: `PrincipalLatch TechJam Demo`
- Project ID: `f84d7465-1b40-414f-b5c0-3e4bfdc71798`
- Timeline ID: `027e7c61-4118-4936-922e-b15cd7f0b884`
- Timeline: 11 visual sections and 11 Frederick voice clips; 5,250 frames at
  30 fps.
- Captions: 40 manually verified English cards, with no overflow.
- Sidecar: `output/demo/PrincipalLatch_Demo_EN_final.srt` (40 corrected cues).
- Video export name: `PrincipalLatch_TechJam_Demo_2m55s.mp4`.
