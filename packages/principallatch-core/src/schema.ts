import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:._-]+$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ed25519Value = z.string().regex(/^ed25519:[A-Za-z0-9+/]+={0,2}$/);
const instant = z.string().datetime({ offset: true });

export const mandateSchema = z
  .object({
    version: z.literal(1),
    mandateId: identifier,
    issuer: z
      .object({
        id: identifier,
        publicKey: ed25519Value,
        kid: z.string().regex(/^[0-9a-f]{16}$/),
        fingerprint: sha256,
      })
      .strict(),
    binding: z
      .object({
        principalId: identifier,
        agentId: identifier,
      })
      .strict(),
    scope: z
      .object({
        action: z.literal("document.read"),
        resourceKind: z.literal("document"),
        ownerRelation: z.literal("self"),
        ruleId: z.literal("rule:document-read-self"),
        clauseId: z.literal("PL-READ-SELF"),
      })
      .strict(),
    commitments: z
      .object({
        profileSha256: sha256,
        revision: z.number().int().positive(),
      })
      .strict(),
    lifecycle: z
      .object({
        issuedAt: instant,
        validUntil: instant,
        status: z.enum(["active", "revoked"]),
        revokedAt: instant.nullable(),
        replaces: identifier.nullable(),
        replacedBy: identifier.nullable(),
      })
      .strict(),
    signature: z.union([z.literal(""), ed25519Value]),
  })
  .strict()
  .superRefine((mandate, context) => {
    const issuedAt = Date.parse(mandate.lifecycle.issuedAt);
    const validUntil = Date.parse(mandate.lifecycle.validUntil);
    if (validUntil <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "validUntil"],
        message: "validUntil must be after issuedAt",
      });
    }
    if (mandate.lifecycle.status === "active" && mandate.lifecycle.revokedAt) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "revokedAt"],
        message: "active mandates cannot have revokedAt",
      });
    }
    if (mandate.lifecycle.status === "revoked" && !mandate.lifecycle.revokedAt) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "revokedAt"],
        message: "revoked mandates require revokedAt",
      });
    }
  });

export type MandateV1 = z.infer<typeof mandateSchema>;

export function parseMandate(input: unknown): MandateV1 {
  return mandateSchema.parse(input);
}
