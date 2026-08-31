import { randomUUID } from "node:crypto";
import type { AuditWriter } from "./audit.js";
import { AuthorityService } from "./authority.js";
import type {
  AgentPassportClaims,
  AuthorizationDecision,
  ResourceOutcome,
  SecurityRejection,
  SecurityRejectionCode,
} from "./contracts.js";
import { PassportBroker, PassportError } from "./passport.js";
import { AuthorityVerificationError } from "./profile.js";
import { ProtectedContentProvider, ResourceCatalog } from "./resources.js";

export type GatewayReadResult =
  | {
      ok: true;
      statusCode: 200;
      requestId: string;
      decision: "allow";
      resource: {
        id: string;
        kind: "document";
        content: string;
      };
    }
  | {
      ok: false;
      statusCode: 403 | 502 | 503;
      requestId: string;
      decision: "deny";
      code: string;
      error: string;
    };

export class PrincipalLatchGateway {
  constructor(
    private readonly passportBroker: PassportBroker,
    private readonly authority: AuthorityService,
    private readonly catalog: ResourceCatalog,
    private readonly contentProvider: ProtectedContentProvider,
    private readonly audit: AuditWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async readDocument(
    authorizationHeader: string | undefined,
    resourceId: string,
  ): Promise<GatewayReadResult> {
    const requestId = randomUUID();
    const occurredAt = this.now().toISOString();
    let claims: AgentPassportClaims | null = null;
    let tokenSha256: string | null = null;

    try {
      const credential = this.passportBroker.verifyAuthorization(
        authorizationHeader,
        Math.floor(this.now().getTime() / 1_000),
      );
      claims = credential.claims;
      tokenSha256 = credential.tokenSha256;
    } catch (error) {
      const rejection =
        error instanceof PassportError
          ? error
          : new PassportError(
              "DENY_PASSPORT_MALFORMED",
              "Agent Passport validation failed",
            );
      const recorded = await this.recordSecurityRejection(
        requestId,
        occurredAt,
        resourceId,
        rejection.code,
        rejection.message,
        null,
        null,
      );
      if (!recorded) return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      return denied(requestId, 403, rejection.code);
    }

    let verified;
    try {
      verified = await this.authority.verifyCurrent(claims, this.now());
    } catch (error) {
      const code: SecurityRejectionCode =
        error instanceof AuthorityVerificationError
          ? error.code
          : "DENY_MANDATE_SCHEMA";
      const detail =
        error instanceof Error ? error.message : "Authority verification failed";
      const recorded = await this.recordSecurityRejection(
        requestId,
        occurredAt,
        resourceId,
        code,
        detail,
        claims,
        this.authority.getCurrent(claims.mandate_id)?.revision ?? null,
      );
      if (!recorded) return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      return denied(requestId, 403, code);
    }

    const resource = this.catalog.lookup(resourceId);
    if (!resource) {
      const event = this.buildDecision({
        requestId,
        occurredAt,
        claims,
        tokenSha256: tokenSha256 as string,
        mandateRevision: verified.record.revision,
        resourceId,
        resourceOwnerPrincipalId: "unknown",
        decision: "deny",
        reasonCode: "DENY_RESOURCE_NOT_ACCESSIBLE",
      });
      if (!(await this.appendDenyEvidence(event, claims, resourceId, "Resource was not available to the verified principal"))) {
        return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      }
      return denied(requestId, 403, "DENY_RESOURCE_NOT_ACCESSIBLE");
    }

    const rule = verified.profile.rules[0];
    if (!rule) {
      const recorded = await this.recordSecurityRejection(
        requestId,
        occurredAt,
        resourceId,
        "DENY_PROFILE_COMMITMENT",
        "Enforcement Profile has no rule",
        claims,
        verified.record.revision,
      );
      if (!recorded) return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      return denied(requestId, 403, "DENY_PROFILE_COMMITMENT");
    }
    const ownerMatches = resource.ownerPrincipalId === claims.act;
    const ruleMatches =
      rule.action === "document.read" &&
      rule.resourceKind === resource.kind &&
      rule.ownerRelation === "self" &&
      ownerMatches;
    const reasonCode = !ownerMatches
      ? "DENY_OWNER_MISMATCH"
      : ruleMatches
        ? "ALLOW_SCOPE_RULE"
        : "DENY_RULE_NOT_MATCHED";
    const decision: "allow" | "deny" = ruleMatches ? "allow" : "deny";
    const event = this.buildDecision({
      requestId,
      occurredAt,
      claims,
      tokenSha256: tokenSha256 as string,
      mandateRevision: verified.record.revision,
      resourceId: resource.id,
      resourceOwnerPrincipalId: resource.ownerPrincipalId,
      decision,
      reasonCode,
    });
    if (decision === "deny") {
      if (!(await this.appendDenyEvidence(
        event,
        claims,
        resourceId,
        "Protected content provider was not called",
      ))) {
        return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      }
      return denied(requestId, 403, reasonCode);
    }
    const attempting = this.buildOutcome({
      requestId,
      resourceId,
      claims,
      status: "attempting",
      detail: "Authorized provider read is about to be attempted",
    });
    if (!(await this.appendEvents([event, attempting]))) {
      return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
    }

    let content: string;
    try {
      content = await this.authority.withVerifiedCurrentLease(
        claims,
        verified.record.revision,
        async () => {
          // Revalidate the short-lived identity inside the same Mandate lease.
          // There is no await between this check and invoking the provider.
          this.passportBroker.verifyAuthorization(
            authorizationHeader,
            Math.floor(this.now().getTime() / 1_000),
          );
          return this.contentProvider.readContent(resource.id);
        },
      );
    } catch (error) {
      if (
        error instanceof AuthorityVerificationError ||
        error instanceof PassportError
      ) {
        const code = error.code;
        const recorded = await this.recordSecurityRejection(
          requestId,
          occurredAt,
          resourceId,
          code,
          error.message,
          claims,
          this.authority.getCurrent(claims.mandate_id)?.revision ?? null,
        );
        if (!recorded) return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
        return denied(requestId, 403, code);
      }
      const outcomeRecorded = await this.appendOutcome({
        requestId,
        resourceId,
        claims,
        status: "failed",
        detail: "Protected content provider failed",
      });
      if (!outcomeRecorded) {
        return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
      }
      return denied(requestId, 502, "RESOURCE_PROVIDER_FAILED");
    }
    const outcomeRecorded = await this.appendOutcome({
      requestId,
      resourceId,
      claims,
      status: "succeeded",
      detail: "Protected content was read after authorization",
    });
    if (!outcomeRecorded) {
      return denied(requestId, 503, "DENY_AUDIT_UNAVAILABLE");
    }
    return {
      ok: true,
      statusCode: 200,
      requestId,
      decision: "allow",
      resource: { id: resource.id, kind: resource.kind, content },
    };
  }

  private buildDecision(input: {
    requestId: string;
    occurredAt: string;
    claims: AgentPassportClaims;
    tokenSha256: string;
    mandateRevision: number;
    resourceId: string;
    resourceOwnerPrincipalId: string;
    decision: "allow" | "deny";
    reasonCode:
      | "ALLOW_SCOPE_RULE"
      | "DENY_OWNER_MISMATCH"
      | "DENY_RESOURCE_NOT_ACCESSIBLE"
      | "DENY_RULE_NOT_MATCHED";
  }): AuthorizationDecision {
    return {
      eventType: "authorization_decision",
      id: randomUUID(),
      requestId: input.requestId,
      occurredAt: input.occurredAt,
      humanPrincipalId: input.claims.act,
      agentPrincipalId: input.claims.sub,
      agentSessionId: input.claims.sid,
      passportJti: input.claims.jti,
      passportTokenSha256: input.tokenSha256,
      mandateId: input.claims.mandate_id,
      mandateRevision: input.mandateRevision,
      action: "document.read",
      resourceId: input.resourceId,
      resourceKind: "document",
      resourceOwnerPrincipalId: input.resourceOwnerPrincipalId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      ruleId:
        input.reasonCode === "ALLOW_SCOPE_RULE" ||
        input.reasonCode === "DENY_OWNER_MISMATCH"
          ? "rule:document-read-self"
          : null,
      clauseId:
        input.reasonCode === "ALLOW_SCOPE_RULE" ||
        input.reasonCode === "DENY_OWNER_MISMATCH"
          ? "PL-READ-SELF"
          : null,
    };
  }

  private async appendEvents(events: readonly (AuthorizationDecision | ResourceOutcome | SecurityRejection)[]): Promise<boolean> {
    try {
      await this.audit.appendBatch(events);
      return true;
    } catch {
      return false;
    }
  }

  private async recordSecurityRejection(
    requestId: string,
    occurredAt: string,
    resourceId: string,
    code: SecurityRejectionCode,
    detail: string,
    claims: AgentPassportClaims | null,
    mandateRevision: number | null,
  ): Promise<boolean> {
    const event: SecurityRejection = {
      eventType: "security_rejection",
      id: randomUUID(),
      requestId,
      occurredAt,
      action: "document.read",
      requestedResourceId: resourceId,
      code,
      humanPrincipalId: claims?.act ?? null,
      agentPrincipalId: claims?.sub ?? null,
      agentSessionId: claims?.sid ?? null,
      passportJti: claims?.jti ?? null,
      mandateId: claims?.mandate_id ?? null,
      mandateRevision,
      detail,
    };
    const outcome = this.buildOutcome({
        requestId,
        resourceId,
        claims,
        status: "not_attempted",
        detail: "Request was rejected before protected content access",
      });
    return this.appendEvents([event, outcome]);
  }

  private async appendOutcome(input: {
    requestId: string;
    resourceId: string;
    claims: AgentPassportClaims | null;
    status: ResourceOutcome["status"];
    detail: string;
  }): Promise<boolean> {
    return this.appendEvents([this.buildOutcome(input)]);
  }

  private buildOutcome(input: {
    requestId: string;
    resourceId: string;
    claims: AgentPassportClaims | null;
    status: ResourceOutcome["status"];
    detail: string;
  }): ResourceOutcome {
    return {
      eventType: "resource_outcome",
      id: randomUUID(),
      requestId: input.requestId,
      occurredAt: this.now().toISOString(),
      humanPrincipalId: input.claims?.act ?? null,
      agentPrincipalId: input.claims?.sub ?? null,
      resourceId: input.resourceId,
      status: input.status,
      providerReadCount: this.contentProvider.readCount(input.resourceId),
      detail: input.detail,
    };
  }

  private appendDenyEvidence(
    decision: AuthorizationDecision,
    claims: AgentPassportClaims,
    resourceId: string,
    detail: string,
  ): Promise<boolean> {
    return this.appendEvents([
      decision,
      this.buildOutcome({
        requestId: decision.requestId,
        resourceId,
        claims,
        status: "not_attempted",
        detail,
      }),
    ]);
  }
}

function denied(
  requestId: string,
  statusCode: 403 | 502 | 503,
  code: string,
): GatewayReadResult {
  return {
    ok: false,
    statusCode,
    requestId,
    decision: "deny",
    code,
    error: statusCode === 403 ? "Access denied" : "Gateway unavailable",
  };
}
