import type {
  Agent,
  AgentRun,
  AgentSecurity,
  AuditEvent,
  DemoData,
  Message,
  PrincipalId,
  SessionResponse,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
let csrfToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token?.trim() ?? "";
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...(mutating && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  session: () => request<SessionResponse>("/api/session"),
  login: (principalId: PrincipalId) =>
    request<SessionResponse>("/api/session", {
      method: "POST",
      body: JSON.stringify({ principalId }),
    }),
  logout: () =>
    request<{ ok: true }>("/api/session", {
      method: "DELETE",
    }),
  demo: () => request<DemoData>("/api/demo/resources"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  security: (id: string) =>
    request<{ security: AgentSecurity }>("/api/agents/" + id + "/security"),
  audit: (id: string) =>
    request<{ events: AuditEvent[] }>("/api/agents/" + id + "/audit"),
  revokeMandate: (id: string) =>
    request<{ security: AgentSecurity }>(
      "/api/agents/" + id + "/mandate/revoke",
      { method: "POST" },
    ),
  startFreshRehearsal: (
    id: string,
    expectedMandateId: string,
    expectedRevision: number,
  ) =>
    request<{ agent: Agent; security: AgentSecurity }>(
      "/api/agents/" + id + "/demo/fresh-rehearsal",
      {
        method: "POST",
        body: JSON.stringify({ expectedMandateId, expectedRevision }),
      },
    ),
};
