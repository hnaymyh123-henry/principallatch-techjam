import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  fingerprintOf,
  kidForPublicKey,
  mandateLifecycleState,
  parseMandate,
  publicKeyFromSeed,
  publicKeyToString,
  signMandate,
  verifyMandate,
  type MandateV1,
} from "../src/index.js";

const seed = new Uint8Array(32).fill(0x17);
const profileHash = `sha256:${"ab".repeat(32)}`;

async function unsignedMandate(): Promise<MandateV1> {
  const publicKey = publicKeyToString(await publicKeyFromSeed(seed));
  return parseMandate({
    version: 1,
    mandateId: "mandate:techjam:alice-agent",
    issuer: {
      id: "service:principallatch-control-plane",
      publicKey,
      kid: kidForPublicKey(publicKey),
      fingerprint: fingerprintOf(publicKey),
    },
    binding: {
      principalId: "user:alice",
      agentId: "agent:alice-researcher",
    },
    scope: {
      action: "document.read",
      resourceKind: "document",
      ownerRelation: "self",
      ruleId: "rule:document-read-self",
      clauseId: "PL-READ-SELF",
    },
    commitments: {
      profileSha256: profileHash,
      revision: 1,
    },
    lifecycle: {
      issuedAt: "2026-08-31T00:00:00.000Z",
      validUntil: "2026-09-07T00:00:00.000Z",
      status: "active",
      revokedAt: null,
      replaces: null,
      replacedBy: null,
    },
    signature: "",
  });
}

describe("PrincipalLatch signed mandate", () => {
  it("strictly rejects unknown authority fields", async () => {
    const mandate = await unsignedMandate();
    expect(() => parseMandate({ ...mandate, algorithm: "none" })).toThrow();
    expect(() =>
      parseMandate({
        ...mandate,
        scope: { ...mandate.scope, ownerRelation: "any" },
      }),
    ).toThrow();
  });

  it("canonicalizes equivalent object insertion orders to identical bytes", async () => {
    const mandate = await unsignedMandate();
    const reordered = {
      signature: mandate.signature,
      lifecycle: mandate.lifecycle,
      commitments: mandate.commitments,
      scope: mandate.scope,
      binding: mandate.binding,
      issuer: mandate.issuer,
      mandateId: mandate.mandateId,
      version: mandate.version,
    } as MandateV1;
    expect(Buffer.from(canonicalBytes(mandate))).toEqual(
      Buffer.from(canonicalBytes(reordered)),
    );
  });

  it("signs without mutating input and verifies issuer metadata", async () => {
    const mandate = await unsignedMandate();
    const before = structuredClone(mandate);
    const signed = await signMandate(mandate, seed);

    expect(mandate).toEqual(before);
    expect(signed.signature).toMatch(/^ed25519:/);
    await expect(verifyMandate(signed)).resolves.toBe(true);
  });

  it("fails verification after binding, scope, or signature tampering", async () => {
    const signed = await signMandate(await unsignedMandate(), seed);
    await expect(
      verifyMandate({
        ...signed,
        binding: { ...signed.binding, principalId: "user:bob" },
      }),
    ).resolves.toBe(false);
    await expect(
      verifyMandate({
        ...signed,
        scope: { ...signed.scope, clauseId: "PL-READ-OTHER" },
      }),
    ).resolves.toBe(false);
    await expect(
      verifyMandate({ ...signed, signature: signed.signature + "A" }),
    ).resolves.toBe(false);
  });

  it("refuses to sign a mandate whose embedded issuer key is not the seed key", async () => {
    const mandate = await unsignedMandate();
    const otherSeed = new Uint8Array(32).fill(0x42);
    await expect(signMandate(mandate, otherSeed)).rejects.toThrow(
      /issuer public key/i,
    );
  });

  it("classifies active, expired, and revoked authority at the verification instant", async () => {
    const mandate = await unsignedMandate();
    expect(mandateLifecycleState(mandate, new Date("2026-09-01T00:00:00Z"))).toBe(
      "active",
    );
    expect(mandateLifecycleState(mandate, new Date("2026-09-08T00:00:00Z"))).toBe(
      "expired",
    );
    expect(
      mandateLifecycleState(
        {
          ...mandate,
          lifecycle: {
            ...mandate.lifecycle,
            status: "revoked",
            revokedAt: "2026-09-01T00:00:00.000Z",
          },
        },
        new Date("2026-09-01T00:00:01Z"),
      ),
    ).toBe("revoked");
  });
});
