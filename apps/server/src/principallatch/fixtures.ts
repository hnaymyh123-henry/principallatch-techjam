import type {
  EnforcementProfileV1,
  HumanPrincipal,
  ResourceCatalogEntry,
} from "./contracts.js";

export const ALICE_PRINCIPAL_ID = "user:alice" as const;
export const BOB_PRINCIPAL_ID = "user:bob" as const;
export const DEMO_AGENT_ID = "a11ce000-0000-4000-8000-000000000001";
export const DEMO_AGENT_PRINCIPAL_ID = "agent:alice-researcher";
export const DEMO_MANDATE_ID =
  "mandate:user:alice:agent:alice-researcher";
export const MANDATE_ISSUER_ID = "service:principallatch-authority";

export const DEMO_PERSONAS: readonly HumanPrincipal[] = [
  {
    id: ALICE_PRINCIPAL_ID,
    displayName: "Alice",
    role: "Agent owner",
  },
  {
    id: BOB_PRINCIPAL_ID,
    displayName: "Bob",
    role: "Cross-user resource owner",
  },
];

export const ENFORCEMENT_PROFILE: EnforcementProfileV1 = {
  version: 1,
  rules: [
    {
      id: "rule:document-read-self",
      clauseId: "PL-READ-SELF",
      action: "document.read",
      resourceKind: "document",
      ownerRelation: "self",
    },
  ],
  defaultDecision: "deny",
};

export const DEMO_RESOURCE_CATALOG: readonly ResourceCatalogEntry[] = [
  {
    id: "alice-doc-001",
    kind: "document",
    ownerPrincipalId: ALICE_PRINCIPAL_ID,
    label: "Alice — Project Aurora brief",
    classification: "private-mock",
  },
  {
    id: "bob-payroll-001",
    kind: "document",
    ownerPrincipalId: BOB_PRINCIPAL_ID,
    label: "Bob — Payroll planning note",
    classification: "private-mock",
  },
];

export const DEMO_AGENT_NAME = "Alice Research Agent";
export const DEMO_AGENT_DESCRIPTION =
  "A Codex Agent that reads private mock documents only through PrincipalLatch.";
export const DEMO_AGENT_INSTRUCTIONS = [
  "For every protected document request, run `node tools/read-document.mjs <resource-id>`.",
  "Use that client for each requested ID, including requests expected to be denied.",
  "Report the exact HTTP decision code and never print environment variables or credentials.",
  "Do not attempt to find protected content in files; it exists only behind the backend gateway.",
].join(" ");

export const TURN_ONE_PROMPT =
  "Boundary test: first read alice-doc-001, then attempt bob-payroll-001. Call the protected document client for both IDs and report each exact gateway result.";

export const TURN_TWO_PROMPT =
  "Revocation test: using this same Agent session, try alice-doc-001 again through the protected document client and report the exact gateway result.";
