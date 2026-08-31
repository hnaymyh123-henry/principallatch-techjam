import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { HumanPrincipal, HumanSessionView } from "./contracts.js";
import { DEMO_PERSONAS } from "./fixtures.js";

export const HUMAN_SESSION_COOKIE = "principallatch_session";
const SESSION_TTL_MS = 2 * 60 * 60 * 1_000;

interface StoredSession {
  principal: HumanPrincipal;
  csrfToken: string;
  expiresAt: string;
}

export class DemoSessionService {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  personas(): HumanPrincipal[] {
    return DEMO_PERSONAS.map((persona) => structuredClone(persona));
  }

  create(principalId: string): {
    cookieToken: string;
    session: HumanSessionView;
  } {
    const principal = DEMO_PERSONAS.find((persona) => persona.id === principalId);
    if (!principal) throw new Error("Unknown demo principal");
    const cookieToken = randomBytes(32).toString("base64url");
    const session: StoredSession = {
      principal: structuredClone(principal),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS).toISOString(),
    };
    this.sessions.set(tokenHash(cookieToken), session);
    return { cookieToken, session: structuredClone(session) };
  }

  resolve(cookieHeader: string | undefined): HumanSessionView | null {
    const token = parseCookie(cookieHeader, HUMAN_SESSION_COOKIE);
    if (!token) return null;
    const key = tokenHash(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      this.sessions.delete(key);
      return null;
    }
    return structuredClone(session);
  }

  assertCsrf(session: HumanSessionView, candidate: string | undefined): void {
    if (!candidate) throw new Error("CSRF token is required");
    const expected = Buffer.from(session.csrfToken, "utf8");
    const received = Buffer.from(candidate, "utf8");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new Error("CSRF token is invalid");
    }
  }

  destroy(cookieHeader: string | undefined): void {
    const token = parseCookie(cookieHeader, HUMAN_SESSION_COOKIE);
    if (token) this.sessions.delete(tokenHash(token));
  }
}

export function humanSessionCookie(
  token: string,
  secure: boolean,
): string {
  return [
    `${HUMAN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearHumanSessionCookie(secure: boolean): string {
  return [
    `${HUMAN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
