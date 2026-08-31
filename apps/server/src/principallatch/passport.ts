import {
  createHash,
  randomBytes,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";
import {
  agentPassportClaimsSchema,
  agentPassportHeaderSchema,
  PASSPORT_AUDIENCE,
  PASSPORT_ISSUER,
  PASSPORT_KID,
  PASSPORT_TYP,
  type AgentPassportClaims,
  type RunCredential,
  type SecurityRejectionCode,
} from "./contracts.js";

const MAX_TOKEN_BYTES = 4_096;

export class PassportError extends Error {
  constructor(
    readonly code: SecurityRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "PassportError";
  }
}

interface PassportSubject {
  principalId: string;
  agentId: string;
  mandateId: string;
}

export class PassportBroker {
  private readonly sessions = new Map<string, RunCredential>();

  constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    private readonly nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly ttlSeconds = 300,
    private readonly randomIdentifier: () => string = () =>
      randomBytes(18).toString("base64url"),
  ) {
    if (ttlSeconds < 1 || ttlSeconds > 300) {
      throw new Error("Passport TTL must be between 1 and 300 seconds");
    }
  }

  getOrIssue(subject: PassportSubject): RunCredential {
    const now = this.nowEpochSeconds();
    const cached = this.sessions.get(subject.agentId);
    if (
      cached &&
      cached.claims.act === subject.principalId &&
      cached.claims.mandate_id === subject.mandateId &&
      cached.claims.exp > now + 5
    ) {
      return structuredClone(cached);
    }

    const claims: AgentPassportClaims = {
      iss: PASSPORT_ISSUER,
      sub: subject.agentId,
      act: subject.principalId,
      sid: `session:${this.randomIdentifier()}`,
      mandate_id: subject.mandateId,
      aud: PASSPORT_AUDIENCE,
      iat: now,
      nbf: now,
      exp: now + this.ttlSeconds,
      jti: `passport:${this.randomIdentifier()}`,
    };
    agentPassportClaimsSchema.parse(claims);
    const header = {
      alg: "EdDSA",
      typ: PASSPORT_TYP,
      kid: PASSPORT_KID,
    } as const;
    const signingInput =
      Buffer.from(JSON.stringify(header)).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = ed25519Sign(null, Buffer.from(signingInput), this.privateKey);
    const token = signingInput + "." + signature.toString("base64url");
    const credential: RunCredential = {
      token,
      claims,
      tokenSha256: sha256(token),
    };
    this.sessions.set(subject.agentId, credential);
    return structuredClone(credential);
  }

  inspect(agentId: string): RunCredential | null {
    const credential = this.sessions.get(agentId);
    return credential ? structuredClone(credential) : null;
  }

  invalidate(agentId: string): void {
    this.sessions.delete(agentId);
  }

  verifyAuthorization(
    authorizationHeader: string | undefined,
    now = this.nowEpochSeconds(),
  ): RunCredential {
    if (!authorizationHeader) {
      throw new PassportError("DENY_PASSPORT_MISSING", "Agent Passport is required");
    }
    if (!authorizationHeader.startsWith("AgentPassport ")) {
      throw new PassportError(
        "DENY_PASSPORT_MALFORMED",
        "Authorization scheme must be AgentPassport",
      );
    }
    const token = authorizationHeader.slice("AgentPassport ".length);
    if (!token || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
      throw new PassportError(
        "DENY_PASSPORT_MALFORMED",
        "Agent Passport has an invalid length",
      );
    }
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !segment)) {
      throw new PassportError(
        "DENY_PASSPORT_MALFORMED",
        "Agent Passport must be a three-part Compact JWS",
      );
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [
      string,
      string,
      string,
    ];

    let header: unknown;
    try {
      header = decodeJson(encodedHeader);
      agentPassportHeaderSchema.parse(header);
    } catch {
      throw new PassportError(
        "DENY_PASSPORT_HEADER",
        "Agent Passport header is not the pinned EdDSA profile",
      );
    }

    let signature: Buffer;
    try {
      signature = decodeBase64Url(encodedSignature);
    } catch {
      throw new PassportError(
        "DENY_PASSPORT_SIGNATURE",
        "Agent Passport signature is malformed",
      );
    }
    const signingInput = encodedHeader + "." + encodedPayload;
    if (
      signature.byteLength !== 64 ||
      !ed25519Verify(null, Buffer.from(signingInput), this.publicKey, signature)
    ) {
      throw new PassportError(
        "DENY_PASSPORT_SIGNATURE",
        "Agent Passport signature did not verify",
      );
    }

    let claims: AgentPassportClaims;
    try {
      claims = agentPassportClaimsSchema.parse(decodeJson(encodedPayload));
    } catch {
      throw new PassportError(
        "DENY_PASSPORT_CLAIMS",
        "Agent Passport claims are invalid or contain unknown fields",
      );
    }
    if (claims.iat > now || claims.nbf > now) {
      throw new PassportError(
        "DENY_PASSPORT_NOT_YET_VALID",
        "Agent Passport is not yet valid",
      );
    }
    if (now >= claims.exp) {
      throw new PassportError("DENY_PASSPORT_EXPIRED", "Agent Passport has expired");
    }
    const tokenSha256 = sha256(token);
    const active = this.sessions.get(claims.sub);
    if (
      !active ||
      active.tokenSha256 !== tokenSha256 ||
      active.claims.sid !== claims.sid ||
      active.claims.jti !== claims.jti
    ) {
      throw new PassportError(
        "DENY_PASSPORT_SESSION",
        "Agent Passport is not the active session for this Agent",
      );
    }
    return { token, claims, tokenSha256 };
  }
}

function decodeJson(encoded: string): unknown {
  const bytes = decodeBase64Url(encoded);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function decodeBase64Url(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid base64url alphabet");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("Non-canonical base64url encoding");
  }
  return decoded;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
