import type { AppConfig } from "../config.js";
import type { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { PersistentAuditLog } from "./audit.js";
import { AuthorityService } from "./authority.js";
import { DemoSessionService } from "./demo-session.js";
import { PrincipalLatchGateway, type GatewayReadResult } from "./gateway.js";
import type {
  AuthorizationDecision,
  GatewayAuditEvent,
  ResourceCatalogEntry,
  ResourceOutcome,
  RunCredentialSummary,
  SecurityRejection,
} from "./contracts.js";
import type { PrincipalLatchKeyMaterial } from "./keys.js";
import { PassportBroker } from "./passport.js";
import { ProtectedContentProvider, ResourceCatalog } from "./resources.js";

export class PrincipalLatchService {
  readonly sessions: DemoSessionService;
  readonly catalog: ResourceCatalog;
  readonly contentProvider: ProtectedContentProvider;
  readonly audit: PersistentAuditLog;
  readonly authority: AuthorityService;
  readonly passportBroker: PassportBroker;
  readonly gateway: PrincipalLatchGateway;

  constructor(
    private readonly config: AppConfig,
    store: JsonStore,
    keys: PrincipalLatchKeyMaterial,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sessions = new DemoSessionService(now);
    this.catalog = new ResourceCatalog();
    this.contentProvider = new ProtectedContentProvider(
      config.principalLatchProtectedContentFile,
    );
    this.audit = new PersistentAuditLog(store);
    this.authority = new AuthorityService(store, keys.mandateSeed, now);
    this.passportBroker = new PassportBroker(
      keys.passportPrivateKey,
      keys.passportPublicKey,
      () => Math.floor(now().getTime() / 1_000),
      config.principalLatchPassportTtlSeconds,
    );
    this.gateway = new PrincipalLatchGateway(
      this.passportBroker,
      this.authority,
      this.catalog,
      this.contentProvider,
      this.audit,
      now,
    );
  }

  async initialize(): Promise<void> {
    await this.contentProvider.initialize();
    await this.authority.initialize();
  }

  async ensureAuthorityForAgent(agent: Agent): Promise<void> {
    await this.authority.installInitialAuthority(
      agent.ownerPrincipalId,
      agent.principalId,
      agent.mandateId,
    );
  }

  credentialForAgent(agent: Agent): {
    passport: string;
    gatewayUrl: string;
    summary: RunCredentialSummary;
  } {
    const credential = this.passportBroker.getOrIssue({
      principalId: agent.ownerPrincipalId,
      agentId: agent.principalId,
      mandateId: agent.mandateId,
    });
    return {
      passport: credential.token,
      gatewayUrl: this.config.principalLatchGatewayUrl,
      summary: {
        agentSessionId: credential.claims.sid,
        passportJti: credential.claims.jti,
        passportExpiresAt: new Date(credential.claims.exp * 1_000).toISOString(),
        passportTokenSha256: credential.tokenSha256,
      },
    };
  }

  endAgentSession(agentPrincipalId: string): void {
    this.passportBroker.invalidate(agentPrincipalId);
  }

  async revoke(agent: Agent): Promise<void> {
    await this.authority.revoke(
      agent.mandateId,
      agent.ownerPrincipalId,
      agent.principalId,
    );
  }

  async retireAgent(agent: Agent): Promise<void> {
    this.passportBroker.invalidate(agent.principalId);
    if (this.authority.effectiveLifecycleStatus(agent.mandateId) === "active") {
      await this.authority.revoke(
        agent.mandateId,
        agent.ownerPrincipalId,
        agent.principalId,
      );
    }
  }

  securitySummary(agent: Agent): Record<string, unknown> {
    const authority = this.authority.getCurrent(agent.mandateId);
    const credential = this.passportBroker.inspect(agent.principalId);
    const mandateStatus = this.authority.effectiveLifecycleStatus(agent.mandateId);
    const currentEvents = this.auditForAgent(agent.principalId, agent.mandateId);
    const auditedSuccessfulReadCounts = Object.fromEntries(
      this.catalog.list().map((resource) => [
        resource.id,
        successfulReadCount(currentEvents, resource.id),
      ]),
    );
    const demo = deriveDemoProof(
      currentEvents,
      credential,
      mandateStatus,
      this.now(),
    );
    return {
      ownerPrincipalId: agent.ownerPrincipalId,
      agentPrincipalId: agent.principalId,
      mandateId: agent.mandateId,
      mandateStatus,
      mandateRevision: authority?.revision ?? null,
      mandateValidUntil: authority?.mandate.lifecycle.validUntil ?? null,
      passport: credential
        ? {
            agentSessionId: credential.claims.sid,
            jti: credential.claims.jti,
            expiresAt: new Date(credential.claims.exp * 1_000).toISOString(),
            tokenSha256: credential.tokenSha256,
          }
        : null,
      trust: this.authority.trustSummary(),
      auditedSuccessfulReadCounts,
      demo,
    };
  }

  resources(): ResourceCatalogEntry[] {
    return this.catalog.list();
  }

  auditForAgent(
    agentPrincipalId: string,
    mandateId?: string,
  ): GatewayAuditEvent[] {
    const events = this.audit.listForAgent(agentPrincipalId);
    if (!mandateId) return events;
    const requestIds = new Set(
      events
        .filter(
          (event) =>
            (event.eventType === "authorization_decision" ||
              event.eventType === "security_rejection") &&
            event.mandateId === mandateId,
        )
        .map((event) => event.requestId),
    );
    return events.filter((event) => requestIds.has(event.requestId));
  }

  readDocument(
    authorizationHeader: string | undefined,
    resourceId: string,
  ): Promise<GatewayReadResult> {
    return this.gateway.readDocument(authorizationHeader, resourceId);
  }
}

function successfulReadCount(
  events: readonly GatewayAuditEvent[],
  resourceId: string,
): number {
  const allowedRequests = new Set(
    events
      .filter(
        (event): event is AuthorizationDecision =>
          event.eventType === "authorization_decision" &&
          event.resourceId === resourceId &&
          event.decision === "allow",
      )
      .map((event) => event.requestId),
  );
  return events.filter(
    (event): event is ResourceOutcome =>
      event.eventType === "resource_outcome" &&
      event.resourceId === resourceId &&
      event.status === "succeeded" &&
      allowedRequests.has(event.requestId),
  ).length;
}

function deriveDemoProof(
  events: readonly GatewayAuditEvent[],
  credential: ReturnType<PassportBroker["inspect"]>,
  mandateStatus: ReturnType<AuthorityService["effectiveLifecycleStatus"]>,
  at: Date,
): Record<string, unknown> {
  const outcomes = new Map<string, ResourceOutcome[]>();
  for (const event of events) {
    if (event.eventType !== "resource_outcome") continue;
    const current = outcomes.get(event.requestId) ?? [];
    current.push(event);
    outcomes.set(event.requestId, current);
  }
  const decisions = events.filter(
    (event): event is AuthorizationDecision =>
      event.eventType === "authorization_decision",
  );
  const aliceAllow = decisions.find(
    (event) =>
      event.resourceId === "alice-doc-001" &&
      event.decision === "allow" &&
      outcomes
        .get(event.requestId)
        ?.some((outcome) => outcome.status === "succeeded"),
  );
  const bobDeny = decisions.find(
    (event) =>
      event.resourceId === "bob-payroll-001" &&
      event.decision === "deny" &&
      event.reasonCode === "DENY_OWNER_MISMATCH" &&
      outcomes
        .get(event.requestId)
        ?.some((outcome) => outcome.status === "not_attempted"),
  );
  const coherentTurnOne = Boolean(
    aliceAllow &&
      bobDeny &&
      aliceAllow.passportJti === bobDeny.passportJti &&
      aliceAllow.passportTokenSha256 === bobDeny.passportTokenSha256,
  );
  const turnOneJti = coherentTurnOne ? aliceAllow?.passportJti ?? null : null;
  const turnOneHash = coherentTurnOne
    ? aliceAllow?.passportTokenSha256 ?? null
    : null;
  const activeCredentialMatches = Boolean(
    credential &&
      credential.claims.jti === turnOneJti &&
      credential.tokenSha256 === turnOneHash &&
      credential.claims.exp * 1_000 > at.getTime(),
  );
  const lifecycleDenial = events.find(
    (event): event is SecurityRejection =>
      Boolean(
        event.eventType === "security_rejection" &&
          event.code === "DENY_MANDATE_LIFECYCLE" &&
          event.passportJti === turnOneJti &&
          outcomes
            .get(event.requestId)
            ?.some((outcome) => outcome.status === "not_attempted"),
      ),
  );

  let phase:
    | "ready_turn_1"
    | "ready_revoke"
    | "ready_turn_2"
    | "complete"
    | "invalid" = "invalid";
  if (mandateStatus === "active") {
    if (coherentTurnOne && activeCredentialMatches) phase = "ready_revoke";
    else if (events.length === 0) phase = "ready_turn_1";
  } else if (
    mandateStatus === "revoked" &&
    coherentTurnOne &&
    activeCredentialMatches
  ) {
    phase = lifecycleDenial ? "complete" : "ready_turn_2";
  }

  return {
    phase,
    turnOneComplete: coherentTurnOne,
    lifecycleDenialComplete: Boolean(lifecycleDenial),
    samePassportActive: activeCredentialMatches,
    passportJti: turnOneJti,
    passportTokenSha256: turnOneHash,
    passportSecondsRemaining: credential
      ? Math.max(0, credential.claims.exp - Math.floor(at.getTime() / 1_000))
      : 0,
  };
}
