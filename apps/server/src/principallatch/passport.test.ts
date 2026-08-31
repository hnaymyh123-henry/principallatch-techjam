import { sign as ed25519Sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PASSPORT_KID } from "./contracts.js";
import { keyMaterialFromSeeds } from "./keys.js";
import { PassportBroker } from "./passport.js";

const seeds = (offset: number) =>
  Uint8Array.from({ length: 32 }, (_, index) => (index + offset) % 256);

describe("Agent Session Passport", () => {
  it("reuses the exact short-lived token for an unchanged Agent session", () => {
    let now = 1_800_000_000;
    const keys = keyMaterialFromSeeds(seeds(1), seeds(90));
    const broker = new PassportBroker(
      keys.passportPrivateKey,
      keys.passportPublicKey,
      () => now,
      300,
      () => "fixed-id",
    );
    const subject = {
      principalId: "user:alice",
      agentId: "agent:alice-researcher",
      mandateId: "mandate:user:alice:agent:alice-researcher",
    };
    const first = broker.getOrIssue(subject);
    now += 20;
    const second = broker.getOrIssue(subject);
    expect(second.token).toBe(first.token);
    expect(second.tokenSha256).toBe(first.tokenSha256);
    expect(second.claims.jti).toBe(first.claims.jti);
    expect(
      broker.verifyAuthorization("AgentPassport " + first.token, now).claims,
    ).toEqual(first.claims);
  });

  it("fails closed on malformed, tampered, foreign-key and expired tokens", () => {
    let now = 1_800_000_000;
    const keys = keyMaterialFromSeeds(seeds(2), seeds(91));
    const broker = new PassportBroker(
      keys.passportPrivateKey,
      keys.passportPublicKey,
      () => now,
      60,
    );
    const credential = broker.getOrIssue({
      principalId: "user:alice",
      agentId: "agent:alice-researcher",
      mandateId: "mandate:user:alice:agent:alice-researcher",
    });
    expect(passportCode(() => broker.verifyAuthorization(undefined, now))).toBe(
      "DENY_PASSPORT_MISSING",
    );
    expect(
      passportCode(() =>
        broker.verifyAuthorization("Bearer " + credential.token, now),
      ),
    ).toBe("DENY_PASSPORT_MALFORMED");

    const parts = credential.token.split(".");
    const signature = parts[2] as string;
    const tampered =
      parts[0] +
      "." +
      parts[1] +
      "." +
      (signature.endsWith("A") ? signature.slice(0, -1) + "B" : signature.slice(0, -1) + "A");
    expect(
      passportCode(() =>
        broker.verifyAuthorization("AgentPassport " + tampered, now),
      ),
    ).toBe("DENY_PASSPORT_SIGNATURE");

    const foreignKeys = keyMaterialFromSeeds(seeds(40), seeds(92));
    const foreignVerifier = new PassportBroker(
      foreignKeys.passportPrivateKey,
      foreignKeys.passportPublicKey,
      () => now,
    );
    expect(
      passportCode(() =>
        foreignVerifier.verifyAuthorization(
          "AgentPassport " + credential.token,
          now,
        ),
      ),
    ).toBe("DENY_PASSPORT_SIGNATURE");

    now = credential.claims.exp;
    expect(
      passportCode(() =>
        broker.verifyAuthorization("AgentPassport " + credential.token, now),
      ),
    ).toBe("DENY_PASSPORT_EXPIRED");
  });

  it("rejects signed headers or claims outside the exact profile", () => {
    const now = 1_800_000_000;
    const keys = keyMaterialFromSeeds(seeds(3), seeds(93));
    const broker = new PassportBroker(
      keys.passportPrivateKey,
      keys.passportPublicKey,
      () => now,
    );
    const valid = broker.getOrIssue({
      principalId: "user:alice",
      agentId: "agent:alice-researcher",
      mandateId: "mandate:user:alice:agent:alice-researcher",
    });
    const wrongHeader = signCompactJws(
      { alg: "none", typ: "agent-passport+jwt", kid: PASSPORT_KID },
      valid.claims,
      keys.passportPrivateKey,
    );
    expect(
      passportCode(() =>
        broker.verifyAuthorization("AgentPassport " + wrongHeader, now),
      ),
    ).toBe("DENY_PASSPORT_HEADER");

    const extraClaims = signCompactJws(
      { alg: "EdDSA", typ: "agent-passport+jwt", kid: PASSPORT_KID },
      { ...valid.claims, canRead: ["alice-doc-001"] },
      keys.passportPrivateKey,
    );
    expect(
      passportCode(() =>
        broker.verifyAuthorization("AgentPassport " + extraClaims, now),
      ),
    ).toBe("DENY_PASSPORT_CLAIMS");
  });

  it("rejects a cryptographically valid Passport after its Agent session ends", () => {
    const now = 1_800_000_000;
    const keys = keyMaterialFromSeeds(seeds(4), seeds(94));
    const broker = new PassportBroker(
      keys.passportPrivateKey,
      keys.passportPublicKey,
      () => now,
    );
    const credential = broker.getOrIssue({
      principalId: "user:alice",
      agentId: "agent:alice-researcher",
      mandateId: "mandate:user:alice:agent:alice-researcher",
    });

    broker.invalidate(credential.claims.sub);

    expect(
      passportCode(() =>
        broker.verifyAuthorization("AgentPassport " + credential.token, now),
      ),
    ).toBe("DENY_PASSPORT_SESSION");
  });
});

function signCompactJws(
  header: unknown,
  payload: unknown,
  privateKey: KeyObject,
): string {
  const input =
    Buffer.from(JSON.stringify(header)).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url");
  return (
    input +
    "." +
    ed25519Sign(null, Buffer.from(input), privateKey).toString("base64url")
  );
}

function passportCode(operation: () => unknown): string {
  try {
    operation();
    throw new Error("Expected Passport verification to fail");
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
}
