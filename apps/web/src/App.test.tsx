import { describe, expect, it } from "vitest";
import { buildAuditRows } from "./App.js";
import type {
  AuditEvent,
  AuthorizationDecisionEvent,
  ResourceOutcomeEvent,
} from "./types.js";

const decision: AuthorizationDecisionEvent = {
  eventType: "authorization_decision",
  id: "decision-1",
  requestId: "request-1",
  occurredAt: "2026-08-31T00:00:00.000Z",
  humanPrincipalId: "user:alice",
  agentPrincipalId: "agent:alice-researcher",
  agentSessionId: "session-1",
  passportJti: "passport-1",
  passportTokenSha256: "sha256:test",
  mandateId: "mandate-1",
  mandateRevision: 1,
  action: "document.read",
  resourceId: "alice-doc-001",
  resourceKind: "document",
  resourceOwnerPrincipalId: "user:alice",
  decision: "allow",
  reasonCode: "ALLOW_SCOPE_RULE",
  ruleId: "rule:document-read-self",
  clauseId: "PL-READ-SELF",
};

function outcome(
  status: ResourceOutcomeEvent["status"],
  providerReadCount: number,
): ResourceOutcomeEvent {
  return {
    eventType: "resource_outcome",
    id: "outcome-" + status,
    requestId: decision.requestId,
    occurredAt: "2026-08-31T00:00:01.000Z",
    humanPrincipalId: decision.humanPrincipalId,
    agentPrincipalId: decision.agentPrincipalId,
    resourceId: decision.resourceId,
    status,
    providerReadCount,
    detail: status,
  };
}

describe("Gateway audit rows", () => {
  it("does not present the pre-access count as final while the provider outcome is unconfirmed", () => {
    const events: AuditEvent[] = [decision, outcome("attempting", 0)];

    expect(buildAuditRows(events)[0]).toMatchObject({
      decision: "allow",
      outcome: "unconfirmed",
      providerReadCount: null,
    });
  });

  it("does not let a reordered attempting event overwrite a persisted terminal outcome", () => {
    const events: AuditEvent[] = [
      decision,
      outcome("succeeded", 1),
      outcome("attempting", 0),
    ];

    expect(buildAuditRows(events)[0]).toMatchObject({
      decision: "allow",
      outcome: "succeeded",
      providerReadCount: 1,
    });
  });
});
