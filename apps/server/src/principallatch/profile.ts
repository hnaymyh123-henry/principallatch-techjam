import { createHash } from "node:crypto";
import type { MandateV1 } from "@principallatch/core";
import {
  enforcementProfileSchema,
  type EnforcementProfileV1,
  type SecurityRejectionCode,
} from "./contracts.js";

export const PROFILE_COMMITMENT_DOMAIN =
  "principallatch/enforcement-profile@1" as const;

export class AuthorityVerificationError extends Error {
  constructor(
    readonly code: SecurityRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityVerificationError";
  }
}

export function parseEnforcementProfile(input: unknown): EnforcementProfileV1 {
  return enforcementProfileSchema.parse(input);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function profileSha256(profile: EnforcementProfileV1): string {
  const parsed = parseEnforcementProfile(profile);
  return `sha256:${createHash("sha256")
    .update(PROFILE_COMMITMENT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(parsed), "utf8")
    .digest("hex")}`;
}

export function assertProfileCommitted(
  mandate: MandateV1,
  profile: EnforcementProfileV1,
): void {
  if (mandate.commitments.profileSha256 !== profileSha256(profile)) {
    throw new AuthorityVerificationError(
      "DENY_PROFILE_COMMITMENT",
      "Signed profile hash does not match the installed enforcement profile",
    );
  }
}

export function assertRevisionCommitted(
  mandate: MandateV1,
  revision: number,
): void {
  if (
    !Number.isInteger(revision) ||
    revision < 1 ||
    mandate.commitments.revision !== revision
  ) {
    throw new AuthorityVerificationError(
      "DENY_REVISION_COMMITMENT",
      "Signed mandate revision does not match the installed authority revision",
    );
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
