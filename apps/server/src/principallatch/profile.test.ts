import { describe, expect, it } from "vitest";
import { ENFORCEMENT_PROFILE } from "./fixtures.js";
import {
  canonicalJson,
  parseEnforcementProfile,
  profileSha256,
} from "./profile.js";

describe("PrincipalLatch enforcement-profile commitment", () => {
  it("matches the published canonical golden vector", () => {
    const canonical = canonicalJson(ENFORCEMENT_PROFILE);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(181);
    expect(canonical).toBe(
      '{"defaultDecision":"deny","rules":[{"action":"document.read","clauseId":"PL-READ-SELF","id":"rule:document-read-self","ownerRelation":"self","resourceKind":"document"}],"version":1}',
    );
    expect(profileSha256(ENFORCEMENT_PROFILE)).toBe(
      "sha256:36afe819936dbbaf2c34975a7ef051d6bead3638a4532505f588cd85f1ee7140",
    );
  });

  it("is independent of object insertion order", () => {
    const reordered = {
      defaultDecision: "deny",
      rules: [
        {
          ownerRelation: "self",
          resourceKind: "document",
          action: "document.read",
          clauseId: "PL-READ-SELF",
          id: "rule:document-read-self",
        },
      ],
      version: 1,
    };
    expect(canonicalJson(parseEnforcementProfile(reordered))).toBe(
      canonicalJson(ENFORCEMENT_PROFILE),
    );
    expect(profileSha256(parseEnforcementProfile(reordered))).toBe(
      profileSha256(ENFORCEMENT_PROFILE),
    );
  });

  it("rejects unknown fields and non-deny defaults", () => {
    expect(() =>
      parseEnforcementProfile({ ...ENFORCEMENT_PROFILE, extra: true }),
    ).toThrow();
    expect(() =>
      parseEnforcementProfile({
        ...ENFORCEMENT_PROFILE,
        defaultDecision: "allow",
      }),
    ).toThrow();
  });
});
