import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken, setCsrfToken } from "./api";
import type {
  Agent,
  AgentRun,
  AgentSecurity,
  AuditEvent,
  DemoData,
  HumanSession,
  Message,
  SystemInfo,
} from "./types";

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

export interface AuditRow {
  requestId: string;
  occurredAt: string;
  humanPrincipalId: string | null;
  agentPrincipalId: string | null;
  action: string;
  resourceId: string;
  decision: "allow" | "deny" | "rejected";
  outcome: "succeeded" | "failed" | "not_attempted" | "unconfirmed";
  reason: string;
  detail: string;
  providerReadCount: number | null;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not issued";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function shortId(value: string | null | undefined, length = 12): string {
  if (!value) return "—";
  if (value.length <= length + 3) return value;
  return value.slice(0, length) + "…";
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function buildAuditRows(events: AuditEvent[]): AuditRow[] {
  const rows = new Map<string, AuditRow>();
  for (const event of events) {
    const current = rows.get(event.requestId) ?? {
      requestId: event.requestId,
      occurredAt: event.occurredAt,
      humanPrincipalId: event.humanPrincipalId,
      agentPrincipalId: event.agentPrincipalId,
      action: "document.read",
      resourceId: "",
      decision: "rejected" as const,
      outcome: "unconfirmed" as const,
      reason: "PENDING",
      detail: "",
      providerReadCount: null,
    };

    if (event.eventType === "authorization_decision") {
      current.occurredAt = event.occurredAt;
      current.humanPrincipalId = event.humanPrincipalId;
      current.agentPrincipalId = event.agentPrincipalId;
      current.action = event.action;
      current.resourceId = event.resourceId;
      current.decision = event.decision;
      current.reason = event.reasonCode;
      current.detail = event.clauseId
        ? `${event.clauseId} · authority revision ${event.mandateRevision}`
        : `authority revision ${event.mandateRevision}`;
    } else if (event.eventType === "security_rejection") {
      current.occurredAt = event.occurredAt;
      current.action = event.action;
      current.resourceId = event.requestedResourceId;
      current.decision = "rejected";
      current.reason = event.code;
      current.detail = event.detail;
    } else {
      current.resourceId = current.resourceId || event.resourceId;
      if (event.status === "attempting") {
        if (current.outcome === "unconfirmed") {
          current.providerReadCount = null;
        }
      } else {
        current.outcome = event.status;
        current.providerReadCount = event.providerReadCount;
      }
      current.detail = current.detail
        ? `${current.detail} · ${event.detail}`
        : event.detail;
    }
    rows.set(event.requestId, current);
  }
  return [...rows.values()].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt),
  );
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function Logo() {
  return <div className="brand-mark" aria-hidden="true">PL</div>;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [session, setSession] = useState<HumanSession | null>(null);
  const [demo, setDemo] = useState<DemoData | null>(null);
  const [security, setSecurity] = useState<AgentSecurity | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [evidenceUpdatedAt, setEvidenceUpdatedAt] = useState<string | null>(null);
  const [evidenceStale, setEvidenceStale] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const auditRows = useMemo(() => buildAuditRows(auditEvents), [auditEvents]);
  const runInProgress =
    activeRun != null && ["queued", "running"].includes(activeRun.status);
  const liveAgentReady = system?.liveAgentReady === true;
  const currentRehearsalRuns = useMemo(
    () => runs.filter((run) => run.mandateId === selected?.mandateId),
    [runs, selected?.mandateId],
  );

  const applySession = useCallback((next: HumanSession | null) => {
    setSession(next);
    setCsrfToken(next?.csrfToken ?? null);
    if (!next) {
      setAgents([]);
      setSelectedId(null);
      setMessages([]);
      setDemo(null);
      setSecurity(null);
      setAuditEvents([]);
      setActiveRun(null);
      setRuns([]);
      setEvidenceUpdatedAt(null);
      setEvidenceStale(false);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    if (!mountedRef.current) return;
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(result.runs);
    }
    return result.runs;
  }, []);

  const refreshSecurityAndAudit = useCallback(async (agentId: string) => {
    const [securityResult, auditResult] = await Promise.all([
      api.security(agentId),
      api.audit(agentId),
    ]);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setSecurity(securityResult.security);
      setAuditEvents(auditResult.events);
      setEvidenceUpdatedAt(new Date().toISOString());
      setEvidenceStale(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    const [agentResult, demoResult] = await Promise.all([
      api.listAgents(),
      api.demo(),
    ]);
    if (!mountedRef.current) return;
    setAgents(agentResult.agents);
    setSelectedId((current) =>
      current && agentResult.agents.some((agent) => agent.id === current)
        ? current
        : (agentResult.agents[0]?.id ?? null),
    );
    setDemo(demoResult);
  }, []);

  const initialize = useCallback(async () => {
    const [systemResult, sessionResult] = await Promise.all([
      api.system(),
      api.session(),
    ]);
    if (!mountedRef.current) return;
    setSystem(systemResult);
    applySession(sessionResult.session);
    if (sessionResult.session) await loadDashboard();
  }, [applySession, loadDashboard]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await initialize();
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      mountedRef.current = false;
    };
  }, [initialize]);

  const pollRun = useCallback(
    async (runId: string, agentId: string) => {
      if (pollingRunIds.current.has(runId)) return;
      pollingRunIds.current.add(runId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 850));
          if (!mountedRef.current) return;
          const result = await api.run(runId);
          if (selectedIdRef.current === agentId) setActiveRun(result.run);
          await refreshSecurityAndAudit(agentId);
          if (!["queued", "running"].includes(result.run.status)) {
            await Promise.all([
              refreshMessages(agentId),
              refreshRuns(agentId),
              refreshAgents(),
              refreshSecurityAndAudit(agentId),
            ]);
            return;
          }
        }
      } finally {
        pollingRunIds.current.delete(runId);
      }
    },
    [refreshAgents, refreshMessages, refreshRuns, refreshSecurityAndAudit],
  );

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setSecurity(null);
    setAuditEvents([]);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([
      refreshMessages(selectedId),
      refreshRuns(selectedId),
      refreshSecurityAndAudit(selectedId),
    ])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [pollRun, refreshMessages, refreshRuns, refreshSecurityAndAudit, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const interval = window.setInterval(() => {
      void refreshSecurityAndAudit(selectedId).catch(() => setEvidenceStale(true));
    }, 2_500);
    return () => window.clearInterval(interval);
  }, [refreshSecurityAndAudit, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    const container = messagesRef.current;
    container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, activeRun]);

  const startAliceDemo = async () => {
    setSessionBusy(true);
    setError(null);
    try {
      const result = await api.login("user:alice");
      applySession(result.session);
      await loadDashboard();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy(false);
    }
  };

  const endSession = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.logout();
      applySession(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") await api.startAgent(selected.id);
      else await api.stopAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete ${selected.name}? Its workspace will be archived.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const revokeMandate = async () => {
    if (!selected || security?.mandateStatus !== "active") return;
    const confirmed = window.confirm(
      "Revoke this Agent's delegated authority? The same Agent Passport will remain visible as a commitment, but the next protected read must be denied.",
    );
    if (!confirmed) return;
    setRevoking(true);
    setError(null);
    try {
      const result = await api.revokeMandate(selected.id);
      setSecurity(result.security);
      await refreshSecurityAndAudit(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRevoking(false);
    }
  };

  const startFreshRehearsal = async () => {
    if (!selected || !security?.mandateRevision) return;
    const confirmed = window.confirm(
      "Start a fresh rehearsal? PrincipalLatch will preserve and revoke the current Mandate, issue a new successor Mandate, rotate the Agent Passport, and reset the seeded Agent session. Historical evidence remains preserved.",
    );
    if (!confirmed) return;
    setResetting(true);
    setError(null);
    try {
      const result = await api.startFreshRehearsal(
        selected.id,
        security.mandateId,
        security.mandateRevision,
      );
      setAgents((current) =>
        current.map((agent) =>
          agent.id === result.agent.id ? result.agent : agent,
        ),
      );
      setSecurity(result.security);
      setActiveRun(null);
      setPrompt("");
      await Promise.all([
        refreshMessages(selected.id),
        refreshRuns(selected.id),
        refreshSecurityAndAudit(selected.id),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResetting(false);
    }
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    if (!liveAgentReady) {
      setError(
        "Live Agent setup is incomplete. Configure the model provider and isolated container Runtime before launching a Run.",
      );
      return;
    }
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await refreshSecurityAndAudit(selected.id);
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await initialize();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <Logo />
          <span className="eyebrow">PrincipalLatch · Track 1 Bouncer</span>
          <h1>Connecting to the trusted control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <Logo />
          <span className="eyebrow">PrincipalLatch · Operator access</span>
          <h1>Enter the control-plane token</h1>
          <p>The platform token is separate from both the Human session and Agent Passport.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <input
            className="credential-username"
            type="text"
            name="username"
            value="principallatch-operator"
            autoComplete="username"
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open PrincipalLatch"}
          </button>
        </form>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="persona-screen">
        <section className="persona-hero">
          <div className="hero-brand"><Logo /><span>PrincipalLatch</span></div>
          <span className="track-label">TikTok TechJam · Agent Middleware · Bouncer</span>
          <h1>One Human delegates one Agent. The backend enforces every read.</h1>
          <p>
            Alice is the only Human who launches the Agent. Bob exists solely as the owner
            of the cross-user negative-test resource required by the challenge—not as a
            second user logged into the runtime.
          </p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="persona-grid persona-grid-single">
            <button
              className="persona-card persona-alice"
              onClick={() => void startAliceDemo()}
              disabled={sessionBusy}
            >
              <span className="persona-avatar">A</span>
              <span className="persona-copy">
                <span className="eyebrow">Agent owner · Human session</span>
                <strong>Continue as Alice</strong>
                <small>Delegate and run the only Agent in this demonstration</small>
              </span>
              <span className="persona-arrow">{sessionBusy ? <Spinner /> : "→"}</span>
            </button>
          </div>
          <div className="boundary-summary">
            <span><b>1</b> Human session</span>
            <i>→</i>
            <span><b>1</b> delegated Agent</span>
            <i>→</i>
            <span><b>2</b> resource owners</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div>
            <strong>PrincipalLatch</strong>
            <span>Agent identity · runtime authority</span>
          </div>
        </div>

        <section className="signed-in-card">
          <span className="persona-avatar small">A</span>
          <div><strong>Alice</strong><span>Agent owner · Human session</span></div>
          <button onClick={() => void endSession()} disabled={busy} title="End demo session" aria-label="End demo session">×</button>
        </section>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Alice&apos;s Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{shortId(agent.principalId, 20)}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
        </nav>

        <div className="runtime-card">
          <div className="runtime-state"><span className="pulse" />Agent Runtime</div>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.modelId
              ? `${system.modelProvider} · ${system.modelId}`
              : "Model provider not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
          <button onClick={() => void endSession()} disabled={busy}>End Human session</button>
        </div>
      </aside>

      <main className="main">
        {system && !system.securityDemoEligible ? (
          <div className="config-banner danger-banner" role="alert">
            <span>!</span>
            <div>
              <strong>Insecure Runtime preview — not valid demo evidence</strong>
              <p>
                This Codex process shares the control-plane OS identity and can read
                signing keys or protected content. Use the disposable container
                Runtime with <code>npm run poc</code> for the judged security demo.
              </p>
            </div>
          </div>
        ) : null}

        {!system?.modelConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Agent Runtime configuration needed</strong>
              <p>
                {!system?.modelConfigured
                  ? "Set MODEL_API_KEY and MODEL_ID before running the live Agent. Security state remains inspectable."
                  : system.runtimeProvider === "container"
                    ? "The container engine or Agent Runtime image is unavailable."
                    : "Codex CLI was not found in the runtime."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <span className="track-label">
                  Track 1 · Bouncer {liveAgentReady ? "live proof" : system?.securityDemoEligible ? "setup incomplete" : "UI preview"}
                </span>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <span className={"mandate-pill mandate-" + (security?.mandateStatus ?? "loading")}>
                    Mandate {security?.mandateStatus ?? "loading"}
                  </span>
                </div>
                <p>{selected.description}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Configure
                </button>
                <button className="button button-ghost" onClick={toggleAgent} disabled={busy}>
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => void startFreshRehearsal()}
                  disabled={resetting || runInProgress || selected.status === "busy"}
                  title="Issue a new successor Mandate; never reactivate a revoked Mandate"
                >
                  {resetting ? <Spinner /> : "Fresh rehearsal"}
                </button>
                <button
                  className="button button-revoke"
                  onClick={() => void revokeMandate()}
                  disabled={revoking || security?.mandateStatus !== "active"}
                >
                  {revoking ? <Spinner /> : security?.mandateStatus === "revoked" ? "Revoked" : "Revoke authority"}
                </button>
                {selected.principalId !== "agent:alice-researcher" ? (
                  <button
                    className="button button-danger icon-button"
                    onClick={deleteAgent}
                    disabled={busy || selected.status === "busy"}
                    title="Delete Agent"
                    aria-label="Delete Agent"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </header>

            <section className="trust-flow" aria-label="PrincipalLatch trust boundary">
              <div><span className="node-icon human-node">A</span><small>Human session</small><b>user:alice</b></div>
              <span className="flow-arrow"><i>delegates</i>→</span>
              <div>
                <span className="node-icon agent-node">⌁</span>
                <small>{system?.securityDemoEligible ? "Disposable runtime" : "Shared-OS preview"}</small>
                <b>{shortId(selected.principalId, 20)}</b>
              </div>
              <span className="flow-arrow gate-arrow"><i>Passport + Mandate</i>→</span>
              <div className="gate-node"><span className="node-icon">◆</span><small>Trusted boundary</small><b>PrincipalLatch</b></div>
              <span className="flow-arrow"><i>allow / deny</i>→</span>
              <div><span className="node-icon resource-node">▤</span><small>Protected provider</small><b>Alice + Bob docs</b></div>
            </section>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div><span className="eyebrow">Agent configuration</span><h2>Instructions and identity</h2></div>
                  <button type="button" onClick={() => setShowSettings(false)} aria-label="Close Agent settings">×</button>
                </div>
                <div className="form-grid">
                  <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={80} /></label>
                  <label>Description<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} /></label>
                </div>
                <label>System instructions<textarea value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} rows={4} maxLength={10_000} /></label>
                <div className="panel-footer"><code>{selected.workspacePath}</code><button className="button button-primary" disabled={busy}>{busy ? <Spinner /> : "Save changes"}</button></div>
              </form>
            )}

            <section className="authority-grid">
              <article>
                <div className="authority-heading"><span className="authority-icon human-node">A</span><div><small>Human session</small><strong>{security?.ownerPrincipalId ?? selected.ownerPrincipalId}</strong></div><span className="verified-mark">✓</span></div>
                <p>Mock identity fixture · opaque HttpOnly session · CSRF protected</p>
              </article>
              <article>
                <div className="authority-heading"><span className="authority-icon agent-node">⌁</span><div><small>Agent principal</small><strong>{shortId(security?.agentPrincipalId ?? selected.principalId, 22)}</strong></div><span className="verified-mark">✓</span></div>
                <p>Owner and Agent are independently identified</p>
              </article>
              <article>
                <div className="authority-heading"><span className="authority-icon passport-node">◇</span><div><small>Agent Session Passport</small><strong>{security?.passport ? shortId(security.passport.agentSessionId, 22) : "Issued on first run"}</strong></div><span className={security?.passport ? "verified-mark" : "pending-mark"}>{security?.passport ? "✓" : "○"}</span></div>
                <p title={security?.passport?.tokenSha256}>Raw credential hidden · SHA-256 {shortId(security?.passport?.tokenSha256, 10)}</p>
              </article>
              <article className={security?.mandateStatus === "revoked" ? "authority-revoked" : ""}>
                <div className="authority-heading"><span className="authority-icon mandate-node">§</span><div><small>Signed Mandate</small><strong>{security?.mandateStatus ?? "Loading"} · revision {security?.mandateRevision ?? "—"}</strong></div><span className={security?.mandateStatus === "active" ? "verified-mark" : "revoked-mark"}>{security?.mandateStatus === "active" ? "✓" : "!"}</span></div>
                <p title={security?.trust.fingerprint}>Trusted local issuer key {shortId(security?.trust.issuerId, 20)} · {shortId(security?.trust.fingerprint, 9)}</p>
              </article>
            </section>

            <section className="demo-layout">
              <div className="playground">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">
                      {liveAgentReady ? "Real Agent Runtime ready" : system?.securityDemoEligible ? "Agent Runtime setup incomplete" : "Agent workflow preview"}
                    </span>
                    <h2>Two-turn boundary test</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Agent session connected" : "New Agent session"}
                    {security ? " · " + humanize(security.demo.phase) : ""}
                  </div>
                </div>

                <div className="messages" ref={messagesRef}>
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit"><div>◆</div></div>
                      <h3>Prove authority at the resource boundary</h3>
                      <p>
                        Turn 1 asks one real Agent to read Alice&apos;s document and then Bob&apos;s.
                        The prompt does not contain a credential or decision—the backend enforces both.
                      </p>
                      <button className="demo-prompt-card" onClick={() => demo && fillPrompt(demo.prompts.turnOne)} disabled={!demo || security?.demo.phase !== "ready_turn_1"}>
                        <span><b>01</b> Boundary test</span>
                        <strong>Fill Turn 1 prompt</strong>
                        <small>Alice allow → Bob deny</small>
                      </button>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta"><strong>{message.role === "user" ? "Alice" : selected.name}</strong><span>{formatTime(message.createdAt)}</span></div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta"><strong>{selected.name}</strong><span>running with injected Agent Passport</span></div>
                      <div className="thinking-row"><Spinner />Codex is calling the protected document client…</div>
                    </article>
                  )}
                  {activeRun?.status === "failed" && <article className="run-error"><strong>Run failed</strong><span>{activeRun.error}</span></article>}
                </div>

                <form className="composer" onSubmit={sendMessage}>
                  <div className="demo-steps">
                    <button type="button" onClick={() => demo && fillPrompt(demo.prompts.turnOne)} disabled={!demo || runInProgress || security?.demo.phase !== "ready_turn_1"}>
                      <span>1</span><b>Fill Turn 1</b><small>allow + cross-user deny</small>
                    </button>
                    <button type="button" onClick={() => void revokeMandate()} disabled={security?.demo.phase !== "ready_revoke" || runInProgress || revoking}>
                      <span>2</span><b>{revoking ? "Revoking…" : "Revoke"}</b><small>advance signed authority revision</small>
                    </button>
                    <button type="button" onClick={() => demo && fillPrompt(demo.prompts.turnTwo)} disabled={!demo || security?.demo.phase !== "ready_turn_2" || runInProgress}>
                      <span>3</span><b>Fill Turn 2</b><small>same session, now denied</small>
                    </button>
                  </div>
                  <textarea
                    ref={composerRef}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={selected.status === "stopped" ? "Start this Agent to continue…" : "Fill a demo prompt or ask the Agent…"}
                    disabled={selected.status === "stopped" || selected.status === "busy" || runInProgress}
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>Prompt fills only—click send to launch the real Agent · {system?.codexSandboxMode ?? "checking sandbox"}</span>
                    <button
                      className="send-button"
                      disabled={!prompt.trim() || !liveAgentReady || selected.status === "stopped" || selected.status === "busy" || runInProgress}
                      aria-label="Run Agent"
                      title={liveAgentReady ? "Launch the real Agent Runtime" : "Configure the model provider and isolated Runtime first"}
                    >Run <b>↑</b></button>
                  </div>
                </form>
              </div>

              <aside className="evidence-panel">
                <div className="evidence-header">
                  <div><span className="eyebrow">Live enforcement evidence</span><h2>Gateway audit</h2></div>
                  <span
                    className={"live-badge" + (evidenceStale ? " stale" : "")}
                    role="status"
                    aria-live="polite"
                    title={evidenceUpdatedAt ? "Last synchronized " + evidenceUpdatedAt : "Evidence has not synchronized yet"}
                  >
                    <i />
                    {evidenceStale ? "Evidence stale" : evidenceUpdatedAt ? "Updated " + formatTime(evidenceUpdatedAt) : "Syncing"}
                  </span>
                </div>

                <div className="resource-cards">
                  {demo?.resources.map((resource) => {
                    const own =
                      resource.ownerPrincipalId ===
                      (security?.ownerPrincipalId ?? selected.ownerPrincipalId);
                    const count = security?.auditedSuccessfulReadCounts[resource.id] ?? 0;
                    return (
                      <article key={resource.id} className={own ? "resource-own" : "resource-foreign"}>
                        <div><span>{own ? "Alice resource" : "Bob resource"}</span><b>{own ? "IN SCOPE" : "OUT OF SCOPE"}</b></div>
                        <strong>{resource.label}</strong>
                        <code>{resource.id}</code>
                        <footer><span>Audited successes</span><em>{count}</em></footer>
                      </article>
                    );
                  })}
                </div>

                <div className="audit-table-wrap">
                  {auditRows.length === 0 ? (
                    <div className="audit-empty"><span>◎</span><strong>No gateway decisions yet</strong><p>Run Turn 1. Evidence appears here from the backend audit log—not from the Agent response.</p></div>
                  ) : (
                    <table className="audit-table">
                      <thead><tr><th>Human / Agent</th><th>Action / Resource</th><th>Decision</th><th>Outcome / Reads</th></tr></thead>
                      <tbody>
                        {auditRows.map((row) => (
                          <tr key={row.requestId}>
                            <td><strong>{shortId(row.humanPrincipalId, 12)}</strong><span>{shortId(row.agentPrincipalId, 18)}</span><small>{formatTime(row.occurredAt)}</small></td>
                            <td><strong>{row.resourceId}</strong><span>{row.action}</span><small title={row.requestId}>req {shortId(row.requestId, 7)}</small></td>
                            <td><span className={"decision-badge decision-" + row.decision}>{row.decision}</span><small title={row.detail}>{humanize(row.reason)}</small></td>
                            <td><span className={"outcome-badge outcome-" + row.outcome} title={row.outcome === "unconfirmed" ? "No persisted terminal provider outcome yet" : undefined}>{humanize(row.outcome)}</span><small>read count <b>{row.providerReadCount ?? "—"}</b></small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="evidence-proof">
                  <div><span>Proof phase</span><b>{humanize(security?.demo.phase ?? "loading")}</b></div>
                  <div><span>Passport commitment</span><code title={security?.demo.passportTokenSha256 ?? security?.passport?.tokenSha256}>{shortId(security?.demo.passportTokenSha256 ?? security?.passport?.tokenSha256, 16)}</code></div>
                  <div><span>Same-Passport TTL</span><b>{security?.demo.passportSecondsRemaining ?? 0}s remaining</b></div>
                  <div><span>Session expires</span><b>{formatDateTime(security?.passport?.expiresAt)}</b></div>
                  <p>The raw Passport is never rendered, persisted in chat, or exposed to the Human browser.</p>
                  {currentRehearsalRuns.slice(0, 3).map((run) => (
                    <div className="run-proof-row" key={run.id}>
                      <span>{run.status} · run {shortId(run.id, 8)}</span>
                      <code title={run.passportTokenSha256}>{shortId(run.passportTokenSha256, 16)}</code>
                      <small title={run.passportJti}>jti {shortId(run.passportJti, 12)}</small>
                    </div>
                  ))}
                </div>
              </aside>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">PL</div>
            <span className="eyebrow">Alice&apos;s control plane</span>
            <h1>Create an Agent with a bound principal and signed Mandate.</h1>
            <p>The demo seed normally creates Alice Research Agent automatically.</p>
            <button className="button button-primary" onClick={() => { setForm(emptyForm); setShowCreate(true); }}>Create Agent</button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title" onSubmit={createAgent} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">New delegated runtime</span><h2 id="create-agent-title">Create an Agent</h2><p>The backend binds the Agent principal and issues its signed Mandate.</p></div>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Close create Agent dialog">×</button>
            </div>
            <label>Name<input autoFocus placeholder="Research Agent" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={80} /></label>
            <label>Description<input placeholder="Reads protected mock documents" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} /></label>
            <label>Instructions<textarea value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} rows={6} maxLength={10_000} /></label>
            <div className="modal-footer"><button type="button" className="button button-ghost" onClick={() => setShowCreate(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <Spinner /> : "Create Agent"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
