import { randomUUID } from "node:crypto";
import { PrincipalLatchService } from "./principallatch/service.js";
import { AuthorityConflictError } from "./principallatch/authority.js";
import {
  ALICE_PRINCIPAL_ID,
  DEMO_AGENT_DESCRIPTION,
  DEMO_AGENT_ID,
  DEMO_AGENT_INSTRUCTIONS,
  DEMO_AGENT_NAME,
  DEMO_AGENT_PRINCIPAL_ID,
  DEMO_MANDATE_ID,
} from "./principallatch/fixtures.js";
import type { AppConfig } from "./config.js";
import { isModelConfigured } from "./config.js";
import { redactRuntimeSecrets } from "./codex-runner.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<void>;
}

export class AgentService {
  private stopping = false;
  private readonly activeExecutions = new Map<string, ActiveExecution>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly principalLatch: PrincipalLatchService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.principalLatch.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        const managedWorkspace = this.workspaces.workspacePath(agent.id);
        if (agent.workspacePath !== managedWorkspace) {
          // Workspace locations are deployment configuration, not portable Agent
          // identity. Rebind restored/migrated state before touching the filesystem.
          agent.workspacePath = managedWorkspace;
        }
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    for (const agent of this.store.snapshot().agents) {
      await this.principalLatch.ensureAuthorityForAgent(agent);
      await this.workspaces.ensure(agent);
    }
    await this.ensureDemoAgent();
  }

  listAgents(actorPrincipalId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.ownerPrincipalId === actorPrincipalId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(actorPrincipalId: string, id: string): Agent {
    const agent = this.getAgentUnchecked(id);
    this.assertAgentOwner(agent, actorPrincipalId);
    return agent;
  }

  async createAgent(
    actorPrincipalId: string,
    input: CreateAgentInput,
  ): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      principalId: `agent:${id}`,
      ownerPrincipalId: actorPrincipalId,
      mandateId: `mandate:${actorPrincipalId}:agent:${id}`,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.principalLatch.ensureAuthorityForAgent(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(
    actorPrincipalId: string,
    id: string,
    input: UpdateAgentInput,
  ): Promise<Agent> {
    const current = this.getAgent(actorPrincipalId, id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertAgentOwner(agent, actorPrincipalId);
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    actorPrincipalId: string,
    id: string,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(actorPrincipalId, id);
    if (agent.id === DEMO_AGENT_ID) {
      throw new HttpError(
        409,
        "The seeded demo Agent is permanent; use Start fresh rehearsal instead",
      );
    }
    await this.cancelExecution(id);
    await this.principalLatch.retireAgent(agent);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startFreshDemoRehearsal(
    actorPrincipalId: string,
    id: string,
    expected: { mandateId: string; revision: number },
  ): Promise<Agent> {
    const agent = this.getAgent(actorPrincipalId, id);
    if (agent.id !== DEMO_AGENT_ID) {
      throw new HttpError(400, "Fresh rehearsal is available only for the seeded demo Agent");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "Stop the active Run before starting a fresh rehearsal");
    }
    if (agent.mandateId !== expected.mandateId) {
      throw new HttpError(409, "The demo Mandate changed; refresh before retrying");
    }
    const current = this.principalLatch.authority.getCurrent(agent.mandateId);
    if (!current || current.revision !== expected.revision) {
      throw new HttpError(409, "The demo Mandate revision changed; refresh before retrying");
    }

    this.principalLatch.endAgentSession(agent.principalId);
    let updated: Agent | null = null;
    try {
      await this.principalLatch.authority.issueSuccessor(
        {
          currentMandateId: expected.mandateId,
          expectedRevision: expected.revision,
          principalId: agent.ownerPrincipalId,
          agentId: agent.principalId,
        },
        (database, successor) => {
          const stored = database.agents.find((item) => item.id === id);
          if (
            !stored ||
            stored.ownerPrincipalId !== actorPrincipalId ||
            stored.mandateId !== expected.mandateId ||
            stored.status === "busy"
          ) {
            throw new AuthorityConflictError(
              "Demo Agent changed while starting a fresh rehearsal",
            );
          }
          stored.mandateId = successor.mandateId;
          stored.name = DEMO_AGENT_NAME;
          stored.description = DEMO_AGENT_DESCRIPTION;
          stored.instructions = DEMO_AGENT_INSTRUCTIONS;
          stored.status = "ready";
          stored.codexThreadId = null;
          stored.lastError = null;
          stored.workspacePath = this.workspaces.workspacePath(DEMO_AGENT_ID);
          stored.updatedAt = now();
          updated = structuredClone(stored);
        },
      );
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        throw new HttpError(409, error.message);
      }
      throw error;
    }
    if (!updated) throw new Error("Demo Agent successor was not installed");
    await this.workspaces.ensure(updated);
    return updated;
  }

  async revokeMandate(
    actorPrincipalId: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    const agent = this.getAgent(actorPrincipalId, id);
    await this.principalLatch.revoke(agent);
    return this.principalLatch.securitySummary(agent);
  }

  async startAgent(actorPrincipalId: string, id: string): Promise<Agent> {
    return this.setStatus(actorPrincipalId, id, "ready");
  }

  async stopAgent(actorPrincipalId: string, id: string): Promise<Agent> {
    const agent = this.getAgent(actorPrincipalId, id);
    await this.cancelExecution(id);
    this.principalLatch.endAgentSession(agent.principalId);
    return this.setStatus(actorPrincipalId, id, "stopped");
  }

  getMessages(actorPrincipalId: string, agentId: string): Message[] {
    const agent = this.getAgent(actorPrincipalId, agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .filter((message) => message.mandateId === agent.mandateId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(actorPrincipalId: string, runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    this.getAgent(actorPrincipalId, run.agentId);
    return run;
  }

  getRuns(actorPrincipalId: string, agentId: string): AgentRun[] {
    const agent = this.getAgent(actorPrincipalId, agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .filter((run) => run.mandateId === agent.mandateId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    actorPrincipalId: string,
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (this.stopping) {
      throw new HttpError(503, "Server is shutting down");
    }
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "The model provider is not configured. Set MODEL_API_KEY and MODEL_ID, then restart.",
      );
    }
    if (!(await this.runner.isAvailable())) {
      throw new HttpError(
        503,
        "The isolated Agent Runtime is unavailable. Check the container engine and Runtime image.",
      );
    }
    const timestamp = now();
    const reservation = await this.store.mutate((database) => {
      if (this.stopping) {
        throw new HttpError(503, "Server is shutting down");
      }
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertAgentOwner(storedAgent, actorPrincipalId);
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const runCredential = this.principalLatch.credentialForAgent(storedAgent);
      const runId = randomUUID();
      const run: AgentRun = {
        id: runId,
        agentId,
        mandateId: storedAgent.mandateId,
        status: "queued",
        prompt,
        output: null,
        error: null,
        usage: null,
        initiatedByPrincipalId: actorPrincipalId,
        agentSessionId: runCredential.summary.agentSessionId,
        passportJti: runCredential.summary.passportJti,
        passportExpiresAt: runCredential.summary.passportExpiresAt,
        passportTokenSha256: runCredential.summary.passportTokenSha256,
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
      };
      const message: Message = {
        id: randomUUID(),
        agentId,
        mandateId: storedAgent.mandateId,
        runId,
        role: "user",
        content: prompt,
        createdAt: timestamp,
      };
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return {
        agentAtStart: snapshot,
        run: structuredClone(run),
        message: structuredClone(message),
        passport: runCredential.passport,
        gatewayUrl: runCredential.gatewayUrl,
      };
    });
    const controller = new AbortController();
    const promise = this.executeRun(
      reservation.agentAtStart,
      reservation.run,
      {
        passport: reservation.passport,
        gatewayUrl: reservation.gatewayUrl,
      },
      controller.signal,
    );
    const execution = { controller, promise };
    this.activeExecutions.set(agentId, execution);
    void promise
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run: reservation.run, message: reservation.message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const modelConfigured = isModelConfigured(this.config);
    const codexAvailable = await this.runner.isAvailable();
    const securityDemoEligible = this.config.runtimeProvider === "container";
    return {
      modelConfigured,
      modelProvider: this.config.modelProviderName,
      modelBaseUrl: this.config.modelBaseUrl,
      modelId: this.config.modelId || null,
      codexAvailable,
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      runtimeIsolation:
        this.config.runtimeProvider === "container"
          ? "isolated-container"
          : "insecure-same-os-user",
      securityDemoEligible,
      liveAgentReady:
        securityDemoEligible && modelConfigured && codexAvailable,
      principalLatchGatewayUrl: this.config.principalLatchGatewayUrl,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "INSECURE preview: Codex shares the control-plane OS user",
    };
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    const cancellationResults = await Promise.allSettled(
      [...this.activeExecutions.keys()].map((agentId) => this.cancelExecution(agentId)),
    );
    const runnerResult = await Promise.allSettled([this.runner.shutdown()]);
    await Promise.allSettled(
      [...this.activeExecutions.values()].map((execution) => execution.promise),
    );
    const failures = [...cancellationResults, ...runnerResult]
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Agent Runtime containers could not be safely removed",
      );
    }
    if (this.activeExecutions.size > 0) {
      throw new Error("Agent executions remained after Runtime shutdown");
    }
  }

  beginShutdown(): void {
    this.stopping = true;
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    principalLatch: { passport: string; gatewayUrl: string },
    signal: AbortSignal,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (signal.aborted) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        signal,
        principalLatch,
      });
      if (signal.aborted) {
        throw new RunCancelledError();
      }
      const safeOutput = redactRuntimeSecrets(
        result.output,
        principalLatch.passport,
        this.config.modelApiKey,
      );
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = safeOutput;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          mandateId: run.mandateId,
          runId: run.id,
          role: "assistant",
          content: safeOutput,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = redactRuntimeSecrets(
        error instanceof Error ? error.message : String(error),
        principalLatch.passport,
        this.config.modelApiKey,
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(
    actorPrincipalId: string,
    id: string,
    status: Agent["status"],
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertAgentOwner(agent, actorPrincipalId);
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    const execution = this.activeExecutions.get(agentId);
    execution?.controller.abort();
    let cancelFailure: unknown = null;
    try {
      await this.runner.cancel(agentId);
    } catch (error) {
      cancelFailure = error;
    }
    if (execution) {
      await execution.promise;
    }
    if (cancelFailure) throw cancelFailure;
  }

  private getAgentUnchecked(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  private assertAgentOwner(agent: Agent, actorPrincipalId: string): void {
    if (agent.ownerPrincipalId !== actorPrincipalId) {
      throw new HttpError(404, "Agent not found");
    }
  }

  private async ensureDemoAgent(): Promise<void> {
    const existing = this.store
      .snapshot()
      .agents.find((agent) => agent.id === DEMO_AGENT_ID);
    if (existing) {
      await this.principalLatch.ensureAuthorityForAgent(existing);
      await this.workspaces.ensure(existing);
      return;
    }
    const timestamp = now();
    const agent: Agent = {
      id: DEMO_AGENT_ID,
      principalId: DEMO_AGENT_PRINCIPAL_ID,
      ownerPrincipalId: ALICE_PRINCIPAL_ID,
      mandateId: DEMO_MANDATE_ID,
      name: DEMO_AGENT_NAME,
      description: DEMO_AGENT_DESCRIPTION,
      instructions: DEMO_AGENT_INSTRUCTIONS,
      status: "ready",
      workspacePath: this.workspaces.workspacePath(DEMO_AGENT_ID),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.principalLatch.ensureAuthorityForAgent(agent);
    await this.store.mutate((database) => database.agents.push(agent));
  }
}
