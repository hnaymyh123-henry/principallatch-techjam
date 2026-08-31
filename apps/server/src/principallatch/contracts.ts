import type { MandateV1 } from "@principallatch/core";
import { z } from "zod";

export const PASSPORT_ISSUER = "principallatch-control-plane" as const;
export const PASSPORT_AUDIENCE = "principallatch-resource-gateway" as const;
export const PASSPORT_KID = "principallatch-passport-v1" as const;
export const PASSPORT_TYP = "agent-passport+jwt" as const;

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:._-]+$/);

export const agentPassportHeaderSchema = z
  .object({
    alg: z.literal("EdDSA"),
    typ: z.literal(PASSPORT_TYP),
    kid: z.literal(PASSPORT_KID),
  })
  .strict();

export const agentPassportClaimsSchema = z
  .object({
    iss: z.literal(PASSPORT_ISSUER),
    sub: identifier,
    act: identifier,
    sid: identifier,
    mandate_id: identifier,
    aud: z.literal(PASSPORT_AUDIENCE),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: identifier,
  })
  .strict()
  .superRefine((claims, context) => {
    if (claims.iat > claims.nbf) {
      context.addIssue({
        code: "custom",
        path: ["nbf"],
        message: "nbf must not precede iat",
      });
    }
    if (claims.nbf >= claims.exp) {
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "exp must be after nbf",
      });
    }
    if (claims.exp - claims.iat <= 0 || claims.exp - claims.iat > 300) {
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "Passport lifetime must be between 1 and 300 seconds",
      });
    }
  });

export type AgentPassportHeader = z.infer<typeof agentPassportHeaderSchema>;
export type AgentPassportClaims = z.infer<typeof agentPassportClaimsSchema>;

export const enforcementRuleSchema = z
  .object({
    id: z.literal("rule:document-read-self"),
    clauseId: z.literal("PL-READ-SELF"),
    action: z.literal("document.read"),
    resourceKind: z.literal("document"),
    ownerRelation: z.literal("self"),
  })
  .strict();

export const enforcementProfileSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(enforcementRuleSchema).length(1),
    defaultDecision: z.literal("deny"),
  })
  .strict();

export type EnforcementProfileV1 = z.infer<typeof enforcementProfileSchema>;

export interface CurrentAuthorityRecord {
  mandateId: string;
  revision: number;
  mandate: MandateV1;
  profile: EnforcementProfileV1;
  installedAt: string;
}

export interface ResourceCatalogEntry {
  id: string;
  kind: "document";
  ownerPrincipalId: string;
  label: string;
  classification: "private-mock";
}

export type AuthorizationReasonCode =
  | "ALLOW_SCOPE_RULE"
  | "DENY_OWNER_MISMATCH"
  | "DENY_RESOURCE_NOT_ACCESSIBLE"
  | "DENY_RULE_NOT_MATCHED";

export type SecurityRejectionCode =
  | "DENY_PASSPORT_MISSING"
  | "DENY_PASSPORT_MALFORMED"
  | "DENY_PASSPORT_HEADER"
  | "DENY_PASSPORT_SIGNATURE"
  | "DENY_PASSPORT_CLAIMS"
  | "DENY_PASSPORT_NOT_YET_VALID"
  | "DENY_PASSPORT_EXPIRED"
  | "DENY_PASSPORT_SESSION"
  | "DENY_AUTHORITY_NOT_FOUND"
  | "DENY_MANDATE_SCHEMA"
  | "DENY_MANDATE_SIGNATURE"
  | "DENY_MANDATE_TRUST"
  | "DENY_MANDATE_BINDING"
  | "DENY_MANDATE_LIFECYCLE"
  | "DENY_PROFILE_COMMITMENT"
  | "DENY_REVISION_COMMITMENT";

export interface SecurityRejection {
  eventType: "security_rejection";
  id: string;
  requestId: string;
  occurredAt: string;
  action: "document.read";
  requestedResourceId: string;
  code: SecurityRejectionCode;
  humanPrincipalId: string | null;
  agentPrincipalId: string | null;
  agentSessionId: string | null;
  passportJti: string | null;
  mandateId: string | null;
  mandateRevision: number | null;
  detail: string;
}

export interface AuthorizationDecision {
  eventType: "authorization_decision";
  id: string;
  requestId: string;
  occurredAt: string;
  humanPrincipalId: string;
  agentPrincipalId: string;
  agentSessionId: string;
  passportJti: string;
  passportTokenSha256: string;
  mandateId: string;
  mandateRevision: number;
  action: "document.read";
  resourceId: string;
  resourceKind: "document";
  resourceOwnerPrincipalId: string;
  decision: "allow" | "deny";
  reasonCode: AuthorizationReasonCode;
  ruleId: "rule:document-read-self" | null;
  clauseId: "PL-READ-SELF" | null;
}

export interface ResourceOutcome {
  eventType: "resource_outcome";
  id: string;
  requestId: string;
  occurredAt: string;
  humanPrincipalId: string | null;
  agentPrincipalId: string | null;
  resourceId: string;
  status: "succeeded" | "failed" | "not_attempted" | "attempting";
  providerReadCount: number;
  detail: string;
}

export type GatewayAuditEvent =
  | SecurityRejection
  | AuthorizationDecision
  | ResourceOutcome;

export interface RunCredential {
  token: string;
  claims: AgentPassportClaims;
  tokenSha256: string;
}

export interface RunCredentialSummary {
  agentSessionId: string;
  passportJti: string;
  passportExpiresAt: string;
  passportTokenSha256: string;
}

export interface HumanPrincipal {
  id: "user:alice" | "user:bob";
  displayName: "Alice" | "Bob";
  role: "Agent owner" | "Cross-user resource owner";
}

export interface HumanSessionView {
  principal: HumanPrincipal;
  csrfToken: string;
  expiresAt: string;
}
