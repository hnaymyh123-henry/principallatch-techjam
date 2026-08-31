import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { PrincipalLatchService } from "./principallatch/service.js";
import {
  clearHumanSessionCookie,
  humanSessionCookie,
} from "./principallatch/demo-session.js";
import type { HumanSessionView } from "./principallatch/contracts.js";
import {
  TURN_ONE_PROMPT,
  TURN_TWO_PROMPT,
} from "./principallatch/fixtures.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const resetDemoBody = z
  .object({
    expectedMandateId: z.string().trim().min(1).max(240),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const loginBody = z
  .object({ principalId: z.literal("user:alice") })
  .strict();
const resourceParams = z.object({
  resourceId: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
  principalLatch: PrincipalLatchService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    credentials: true,
  });

  // Fastify snapshots the active error handler when a route is registered.
  // Install ours before any route so Zod and domain errors cannot fall through
  // to the default 500 response.
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    const matchedRoute = request.routeOptions.url ?? "";
    if (
      !config.authToken ||
      !matchedRoute.startsWith("/api/") ||
      matchedRoute === "/api/health" ||
      matchedRoute === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "principallatch",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/session", async (request) => ({
    session: principalLatch.sessions.resolve(request.headers.cookie),
    personas: principalLatch.sessions.personas(),
  }));

  app.post("/api/session", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const { principalId } = loginBody.parse(request.body);
    const created = principalLatch.sessions.create(principalId);
    reply.header(
      "set-cookie",
      humanSessionCookie(created.cookieToken, config.sessionCookieSecure),
    );
    return { session: created.session, personas: principalLatch.sessions.personas() };
  });
  await app.register(rateLimit, { global: false });

  app.delete("/api/session", async (request, reply) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    principalLatch.sessions.destroy(request.headers.cookie);
    reply.header(
      "set-cookie",
      clearHumanSessionCookie(config.sessionCookieSecure),
    );
    return { ok: true };
  });

  app.get("/api/demo/resources", async (request) => {
    requireHuman(request, principalLatch);
    return {
      resources: principalLatch.resources(),
      prompts: { turnOne: TURN_ONE_PROMPT, turnTwo: TURN_TWO_PROMPT },
    };
  });

  app.get("/api/agents", async (request) => {
    const session = requireHuman(request, principalLatch);
    return { agents: service.listAgents(session.principal.id) };
  });

  app.post("/api/agents", async (request, reply) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(session.principal.id, body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(session.principal.id, id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(session.principal.id, id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(session.principal.id, id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(session.principal.id, id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(session.principal.id, id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(session.principal.id, id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(session.principal.id, id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(session.principal.id, id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(session.principal.id, id) };
  });

  app.get("/api/agents/:id/security", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(session.principal.id, id);
    return { security: principalLatch.securitySummary(agent) };
  });

  app.get("/api/agents/:id/audit", async (request) => {
    const session = requireHuman(request, principalLatch);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(session.principal.id, id);
    return {
      events: principalLatch.auditForAgent(agent.principalId, agent.mandateId),
    };
  });

  app.post("/api/agents/:id/mandate/revoke", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    return {
      security: await service.revokeMandate(session.principal.id, id),
    };
  });

  app.post("/api/agents/:id/demo/fresh-rehearsal", async (request) => {
    const session = requireHuman(request, principalLatch);
    assertHumanMutation(request, config, principalLatch, session);
    const { id } = agentIdParams.parse(request.params);
    const body = resetDemoBody.parse(request.body);
    const agent = await service.startFreshDemoRehearsal(
      session.principal.id,
      id,
      { mandateId: body.expectedMandateId, revision: body.expectedRevision },
    );
    return { agent, security: principalLatch.securitySummary(agent) };
  });

  app.get(
    "/v1/documents/:resourceId",
    {
      config: {
        rateLimit: {
          max: config.principalLatchGatewayRateLimitMax,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { resourceId } = resourceParams.parse(request.params);
      const result = await principalLatch.readDocument(
        request.headers.authorization,
        resourceId,
      );
      reply.header("cache-control", "no-store");
      return reply.code(result.statusCode).send(result);
    },
  );

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

function requireHuman(
  request: FastifyRequest,
  principalLatch: PrincipalLatchService,
): HumanSessionView {
  const session = principalLatch.sessions.resolve(request.headers.cookie);
  if (!session) throw new HttpError(401, "Human session required");
  return session;
}

function assertHumanMutation(
  request: FastifyRequest,
  config: AppConfig,
  principalLatch: PrincipalLatchService,
  session: HumanSessionView,
): void {
  assertTrustedOrigin(request, config);
  const csrfHeader = request.headers["x-csrf-token"];
  const csrf = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
  try {
    principalLatch.sessions.assertCsrf(session, csrf);
  } catch {
    throw new HttpError(403, "CSRF validation failed");
  }
}

function assertTrustedOrigin(request: FastifyRequest, config: AppConfig): void {
  const origin = request.headers.origin;
  if (!origin && config.nodeEnv === "test") return;
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, "Untrusted request origin");
  }
}
