export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type PrincipalId = "user:alice" | "user:bob";

export interface HumanPrincipal {
  id: PrincipalId;
  displayName: "Alice" | "Bob";
  role: "Agent owner" | "Cross-user resource owner";
}

export interface HumanSession {
  principal: HumanPrincipal;
  csrfToken: string;
  expiresAt: string;
}

export interface SessionResponse {
  session: HumanSession | null;
  personas: HumanPrincipal[];
}

export interface Agent {
  id: string;
  principalId: string;
  ownerPrincipalId: string;
  mandateId: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  mandateId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  mandateId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  initiatedByPrincipalId: string;
  agentSessionId: string;
  passportJti: string;
  passportExpiresAt: string;
  passportTokenSha256: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  runtimeIsolation: "isolated-container" | "insecure-same-os-user";
  securityDemoEligible: boolean;
  liveAgentReady: boolean;
  containerEngine: string | null;
  runtime: string;
}

export interface DemoResource {
  id: string;
  kind: "document";
  ownerPrincipalId: string;
  label: string;
  classification: "private-mock";
}

export interface DemoData {
  resources: DemoResource[];
  prompts: {
    turnOne: string;
    turnTwo: string;
  };
}

export interface AgentSecurity {
  ownerPrincipalId: string;
  agentPrincipalId: string;
  mandateId: string;
  mandateStatus: "active" | "revoked" | "expired" | "missing" | string;
  mandateRevision: number | null;
  mandateValidUntil: string | null;
  passport: {
    agentSessionId: string;
    jti: string;
    expiresAt: string;
    tokenSha256: string;
  } | null;
  trust: {
    issuerId: string;
    issuerKid: string;
    fingerprint: string;
  };
  auditedSuccessfulReadCounts: Record<string, number>;
  demo: {
    phase:
      | "ready_turn_1"
      | "ready_revoke"
      | "ready_turn_2"
      | "complete"
      | "invalid";
    turnOneComplete: boolean;
    lifecycleDenialComplete: boolean;
    samePassportActive: boolean;
    passportJti: string | null;
    passportTokenSha256: string | null;
    passportSecondsRemaining: number;
  };
}

export type AuthorizationReasonCode =
  | "ALLOW_SCOPE_RULE"
  | "DENY_OWNER_MISMATCH"
  | "DENY_RESOURCE_NOT_ACCESSIBLE"
  | "DENY_RULE_NOT_MATCHED";

export interface SecurityRejectionEvent {
  eventType: "security_rejection";
  id: string;
  requestId: string;
  occurredAt: string;
  action: "document.read";
  requestedResourceId: string;
  code: string;
  humanPrincipalId: string | null;
  agentPrincipalId: string | null;
  agentSessionId: string | null;
  passportJti: string | null;
  mandateId: string | null;
  mandateRevision: number | null;
  detail: string;
}

export interface AuthorizationDecisionEvent {
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

export interface ResourceOutcomeEvent {
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

export type AuditEvent =
  | SecurityRejectionEvent
  | AuthorizationDecisionEvent
  | ResourceOutcomeEvent;
