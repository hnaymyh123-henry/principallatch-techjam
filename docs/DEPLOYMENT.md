# Deployment status

The official Track 1 guide makes local Docker/Colima/Podman execution the
default judging path and cloud deployment optional. PrincipalLatch therefore
supports one deployment profile for its security claim:

```text
trusted Fastify process on the judge host
        +
fresh Docker/Podman container for each Codex turn
```

Run that profile with `npm run poc`; see [LOCAL_POC.md](LOCAL_POC.md).

## Unsupported all-in-one deployment paths are intentionally omitted

The organizer scaffold included optional all-in-one local/cloud examples. They
place Fastify, trusted JSON/key/content state, and Codex in one container or
host trust domain, where the Agent could read control-plane secrets directly.
PrincipalLatch therefore does not ship those examples in its standalone
repository and does not use them as judging or security evidence.

No public endpoint or cloud deployment is claimed in
[SUBMISSION.md](SUBMISSION.md).

## What a future cloud profile would require

A credible cloud deployment must preserve the same physical trust split:

1. run Fastify and its key/content/state directories in a trusted host service;
2. launch a fresh disposable worker container for each Agent turn;
3. mount only that Agent's workspace and Codex home;
4. never expose the container-engine socket to the Agent container;
5. place Human routes behind HTTPS and an independently generated operator
   token;
6. add managed secret storage, key rotation, durable transactional authority and
   audit storage, distributed rate limiting, and constrained egress; and
7. repeat the malicious-mount, cleanup, allow/deny/revoke, and secret-redaction
   verification on the deployed host.

Until that profile exists and has fresh evidence, cloud remains future work—not
a shortcut around the required local live-Agent demonstration.
