import type { MandateV1 } from "./schema.js";

export type MandateLifecycleState =
  | "active"
  | "revoked"
  | "expired"
  | "not_yet_valid";

export function mandateLifecycleState(
  mandate: MandateV1,
  at: Date,
): MandateLifecycleState {
  if (!Number.isFinite(at.getTime())) {
    throw new Error("Lifecycle verification instant is invalid");
  }
  if (mandate.lifecycle.status === "revoked") return "revoked";
  const issuedAt = Date.parse(mandate.lifecycle.issuedAt);
  const validUntil = Date.parse(mandate.lifecycle.validUntil);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil)) {
    throw new Error("Mandate lifecycle contains an invalid instant");
  }
  if (at.getTime() < issuedAt) return "not_yet_valid";
  if (at.getTime() >= validUntil) return "expired";
  return "active";
}
