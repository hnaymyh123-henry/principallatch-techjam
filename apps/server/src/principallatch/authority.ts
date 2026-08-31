import {
  fingerprintOf,
  kidForPublicKey,
  mandateLifecycleState,
  parseMandate,
  publicKeyFromSeed,
  publicKeyToString,
  signMandate,
  verifyMandate,
  type MandateV1,
} from "@principallatch/core";
import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import type {
  AgentPassportClaims,
  CurrentAuthorityRecord,
  EnforcementProfileV1,
} from "./contracts.js";
import {
  ALICE_PRINCIPAL_ID,
  BOB_PRINCIPAL_ID,
  DEMO_AGENT_PRINCIPAL_ID,
  DEMO_MANDATE_ID,
  ENFORCEMENT_PROFILE,
  MANDATE_ISSUER_ID,
} from "./fixtures.js";
import {
  assertProfileCommitted,
  assertRevisionCommitted,
  AuthorityVerificationError,
  parseEnforcementProfile,
  profileSha256,
} from "./profile.js";

export interface VerifiedAuthority {
  record: CurrentAuthorityRecord;
  mandate: MandateV1;
  profile: EnforcementProfileV1;
}

export class AuthorityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityConflictError";
  }
}

export class AuthorityService {
  private issuerPublicKey = "";
  private issuerKid = "";
  private issuerFingerprint = "";
  private initialized = false;
  private readonly mandateOperations = new Map<string, Promise<void>>();
  private readonly allowedPrincipalIds = new Set<string>([
    ALICE_PRINCIPAL_ID,
    BOB_PRINCIPAL_ID,
  ]);

  constructor(
    private readonly store: JsonStore,
    private readonly mandateSeed: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await this.ensureCryptoInitialized();
    if (!this.getCurrent(DEMO_MANDATE_ID)) {
      await this.installInitialAuthority(
        ALICE_PRINCIPAL_ID,
        DEMO_AGENT_PRINCIPAL_ID,
        DEMO_MANDATE_ID,
      );
    }
  }

  getCurrent(mandateId: string): CurrentAuthorityRecord | null {
    const record = this.store
      .snapshot()
      .authorityRecords.find((item) => item.mandateId === mandateId);
    return record ? structuredClone(record) : null;
  }

  async installInitialAuthority(
    principalId: string,
    agentId: string,
    mandateId: string,
  ): Promise<CurrentAuthorityRecord> {
    await this.ensureCryptoInitialized();
    if (!this.allowedPrincipalIds.has(principalId)) {
      throw new AuthorityVerificationError(
        "DENY_MANDATE_TRUST",
        "Issuer is not configured for this principal",
      );
    }
    const existing = this.getCurrent(mandateId);
    if (existing) return existing;
    const record = await this.issueRecord({
      mandateId,
      principalId,
      agentId,
      revision: 1,
      replaces: null,
    });
    await this.store.mutate((database) => {
      if (database.authorityRecords.some((item) => item.mandateId === mandateId)) {
        throw new Error("Authority record was concurrently installed");
      }
      database.authorityRecords.push(record);
    });
    return structuredClone(record);
  }

  async verifyCurrent(
    claims: AgentPassportClaims,
    at = this.now(),
  ): Promise<VerifiedAuthority> {
    const record = this.getCurrent(claims.mandate_id);
    if (!record) {
      throw new AuthorityVerificationError(
        "DENY_AUTHORITY_NOT_FOUND",
        "No current authority record exists for this Passport",
      );
    }
    return this.verifyRecord(record, {
      principalId: claims.act,
      agentId: claims.sub,
      mandateId: claims.mandate_id,
      at,
      requireActive: true,
    });
  }

  async withVerifiedCurrentLease<T>(
    claims: AgentPassportClaims,
    expectedRevision: number,
    operation: (verified: VerifiedAuthority) => Promise<T>,
  ): Promise<T> {
    return this.withMandateOperation(claims.mandate_id, async () => {
      const verified = await this.verifyCurrent(claims, this.now());
      if (verified.record.revision !== expectedRevision) {
        throw new AuthorityVerificationError(
          "DENY_REVISION_COMMITMENT",
          "Current mandate revision changed before protected content access",
        );
      }
      return operation(verified);
    });
  }

  async revoke(
    mandateId: string,
    expectedPrincipalId: string,
    expectedAgentId: string,
  ): Promise<CurrentAuthorityRecord> {
    return this.withMandateOperation(mandateId, async () => {
      const current = this.getCurrent(mandateId);
      if (!current) {
        throw new AuthorityVerificationError(
          "DENY_AUTHORITY_NOT_FOUND",
          "Current authority record was not found",
        );
      }
      await this.verifyRecord(current, {
        principalId: expectedPrincipalId,
        agentId: expectedAgentId,
        mandateId,
        at: this.now(),
        requireActive: true,
      });
      const next = await this.issueRevokedRevision(current, null);
      await this.store.mutate((database) => {
        const index = database.authorityRecords.findIndex(
          (record) => record.mandateId === mandateId,
        );
        if (
          index < 0 ||
          database.authorityRecords[index]?.revision !== current.revision
        ) {
          throw new AuthorityConflictError("Authority compare-and-set conflict");
        }
        database.authorityRecords[index] = next;
      });
      return structuredClone(next);
    });
  }

  async issueSuccessor(
    input: {
      currentMandateId: string;
      expectedRevision: number;
      principalId: string;
      agentId: string;
    },
    applySuccessor: (
      database: Database,
      successor: CurrentAuthorityRecord,
    ) => void,
  ): Promise<{
    predecessor: CurrentAuthorityRecord;
    successor: CurrentAuthorityRecord;
  }> {
    return this.withMandateOperation(input.currentMandateId, async () => {
      const current = this.getCurrent(input.currentMandateId);
      if (!current || current.revision !== input.expectedRevision) {
        throw new AuthorityConflictError(
          "Current mandate or revision changed; refresh before starting a new rehearsal",
        );
      }
      await this.verifyRecord(current, {
        principalId: input.principalId,
        agentId: input.agentId,
        mandateId: input.currentMandateId,
        at: this.now(),
        requireActive: false,
      });
      const rootId = input.currentMandateId.split(":successor:", 1)[0];
      const successorId = `${rootId}:successor:${randomUUID()}`;
      const predecessor = await this.issueRevokedRevision(current, successorId);
      const successor = await this.issueRecord({
        mandateId: successorId,
        principalId: input.principalId,
        agentId: input.agentId,
        revision: 1,
        replaces: input.currentMandateId,
      });

      await this.store.mutate((database) => {
        const currentIndex = database.authorityRecords.findIndex(
          (record) => record.mandateId === input.currentMandateId,
        );
        if (
          currentIndex < 0 ||
          database.authorityRecords[currentIndex]?.revision !==
            input.expectedRevision ||
          database.authorityRecords.some(
            (record) => record.mandateId === successor.mandateId,
          )
        ) {
          throw new AuthorityConflictError(
            "Authority compare-and-set conflict while starting a new rehearsal",
          );
        }
        database.authorityRecords[currentIndex] = predecessor;
        database.authorityRecords.push(successor);
        applySuccessor(database, successor);
      });
      return {
        predecessor: structuredClone(predecessor),
        successor: structuredClone(successor),
      };
    });
  }

  trustSummary(): { issuerId: string; issuerKid: string; fingerprint: string } {
    return {
      issuerId: MANDATE_ISSUER_ID,
      issuerKid: this.issuerKid,
      fingerprint: this.issuerFingerprint,
    };
  }

  effectiveLifecycleStatus(
    mandateId: string,
    at = this.now(),
  ): "active" | "revoked" | "expired" | "not_yet_valid" | "missing" {
    const record = this.getCurrent(mandateId);
    if (!record) return "missing";
    try {
      return mandateLifecycleState(parseMandate(record.mandate), at);
    } catch {
      return "expired";
    }
  }

  private async verifyRecord(
    record: CurrentAuthorityRecord,
    expected: {
      principalId: string;
      agentId: string;
      mandateId: string;
      at: Date;
      requireActive: boolean;
    },
  ): Promise<VerifiedAuthority> {
    await this.ensureCryptoInitialized();
    let mandate: MandateV1;
    try {
      mandate = parseMandate(record.mandate);
    } catch {
      throw new AuthorityVerificationError(
        "DENY_MANDATE_SCHEMA",
        "Current mandate failed strict schema validation",
      );
    }
    if (!(await verifyMandate(mandate))) {
      throw new AuthorityVerificationError(
        "DENY_MANDATE_SIGNATURE",
        "Current mandate signature did not verify",
      );
    }
    if (
      mandate.issuer.id !== MANDATE_ISSUER_ID ||
      mandate.issuer.publicKey !== this.issuerPublicKey ||
      mandate.issuer.kid !== this.issuerKid ||
      mandate.issuer.fingerprint !== this.issuerFingerprint ||
      fingerprintOf(mandate.issuer.publicKey) !== this.issuerFingerprint ||
      !this.allowedPrincipalIds.has(expected.principalId)
    ) {
      throw new AuthorityVerificationError(
        "DENY_MANDATE_TRUST",
        "Mandate does not match the pinned local issuer and principal namespace",
      );
    }
    if (
      mandate.mandateId !== expected.mandateId ||
      record.mandateId !== expected.mandateId ||
      mandate.binding.principalId !== expected.principalId ||
      mandate.binding.agentId !== expected.agentId
    ) {
      throw new AuthorityVerificationError(
        "DENY_MANDATE_BINDING",
        "Mandate binding does not match the verified Passport",
      );
    }

    let profile: EnforcementProfileV1;
    try {
      profile = parseEnforcementProfile(record.profile);
    } catch {
      throw new AuthorityVerificationError(
        "DENY_PROFILE_COMMITMENT",
        "Stored enforcement profile is invalid",
      );
    }
    assertRevisionCommitted(mandate, record.revision);
    assertProfileCommitted(mandate, profile);
    const rule = profile.rules[0];
    if (
      !rule ||
      rule.id !== mandate.scope.ruleId ||
      rule.clauseId !== mandate.scope.clauseId ||
      rule.action !== mandate.scope.action ||
      rule.resourceKind !== mandate.scope.resourceKind ||
      rule.ownerRelation !== mandate.scope.ownerRelation
    ) {
      throw new AuthorityVerificationError(
        "DENY_PROFILE_COMMITMENT",
        "Installed enforcement rule does not match the signed mandate scope",
      );
    }

    if (expected.requireActive) {
      let lifecycle: ReturnType<typeof mandateLifecycleState>;
      try {
        lifecycle = mandateLifecycleState(mandate, expected.at);
      } catch {
        lifecycle = "expired";
      }
      if (
        lifecycle !== "active" ||
        mandate.lifecycle.revokedAt !== null ||
        mandate.lifecycle.replacedBy !== null
      ) {
        throw new AuthorityVerificationError(
          "DENY_MANDATE_LIFECYCLE",
          "Current mandate is not strictly active at request time",
        );
      }
    }

    return {
      record: structuredClone(record),
      mandate,
      profile,
    };
  }

  private async issueRecord(input: {
    mandateId: string;
    principalId: string;
    agentId: string;
    revision: number;
    replaces: string | null;
  }): Promise<CurrentAuthorityRecord> {
    const issuedAt = this.now();
    const validUntil = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const profile = structuredClone(ENFORCEMENT_PROFILE);
    const unsigned = parseMandate({
      version: 1,
      mandateId: input.mandateId,
      issuer: {
        id: MANDATE_ISSUER_ID,
        publicKey: this.issuerPublicKey,
        kid: this.issuerKid,
        fingerprint: this.issuerFingerprint,
      },
      binding: {
        principalId: input.principalId,
        agentId: input.agentId,
      },
      scope: {
        action: "document.read",
        resourceKind: "document",
        ownerRelation: "self",
        ruleId: "rule:document-read-self",
        clauseId: "PL-READ-SELF",
      },
      commitments: {
        profileSha256: profileSha256(profile),
        revision: input.revision,
      },
      lifecycle: {
        issuedAt: issuedAt.toISOString(),
        validUntil: validUntil.toISOString(),
        status: "active",
        revokedAt: null,
        replaces: input.replaces,
        replacedBy: null,
      },
      signature: "",
    });
    const signed = await signMandate(unsigned, this.mandateSeed);
    if (!(await verifyMandate(signed))) {
      throw new Error("Issuer produced a mandate that failed self-verification");
    }
    return {
      mandateId: input.mandateId,
      revision: input.revision,
      mandate: signed,
      profile,
      installedAt: issuedAt.toISOString(),
    };
  }

  private async issueRevokedRevision(
    current: CurrentAuthorityRecord,
    replacedBy: string | null,
  ): Promise<CurrentAuthorityRecord> {
    const changedAt = this.now();
    const nextRevision = current.revision + 1;
    const nextMandate = structuredClone(current.mandate);
    nextMandate.lifecycle.status = "revoked";
    nextMandate.lifecycle.revokedAt ??= changedAt.toISOString();
    nextMandate.lifecycle.replacedBy = replacedBy;
    nextMandate.commitments.profileSha256 = profileSha256(current.profile);
    nextMandate.commitments.revision = nextRevision;
    nextMandate.signature = "";
    const signed = await signMandate(parseMandate(nextMandate), this.mandateSeed);
    if (!(await verifyMandate(signed))) {
      throw new Error("Issuer produced a mandate that failed self-verification");
    }
    return {
      mandateId: current.mandateId,
      revision: nextRevision,
      mandate: signed,
      profile: structuredClone(current.profile),
      installedAt: changedAt.toISOString(),
    };
  }

  private async withMandateOperation<T>(
    mandateId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mandateOperations.get(mandateId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.mandateOperations.set(mandateId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.mandateOperations.get(mandateId) === tail) {
        this.mandateOperations.delete(mandateId);
      }
    }
  }

  private async ensureCryptoInitialized(): Promise<void> {
    if (this.initialized) return;
    const publicKey = await publicKeyFromSeed(this.mandateSeed);
    this.issuerPublicKey = publicKeyToString(publicKey);
    this.issuerKid = kidForPublicKey(this.issuerPublicKey);
    this.issuerFingerprint = fingerprintOf(this.issuerPublicKey);
    this.initialized = true;
  }
}
