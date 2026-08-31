import { signMandate } from "@principallatch/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../test-context.js";
import { ALICE_PRINCIPAL_ID } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function context() {
  const root = await mkdtemp(path.join(tmpdir(), "principallatch-authority-test-"));
  temporaryDirectories.push(root);
  return createTestContext(root);
}

describe("Current signed-mandate authority verification", () => {
  it("verifies the pinned issuer, exact principal-agent binding, scope and revision", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const parsed = test.principalLatch.passportBroker.verifyAuthorization(
      "AgentPassport " + credential.passport,
    );
    const verified = await test.principalLatch.authority.verifyCurrent(parsed.claims);

    expect(verified.record.revision).toBe(1);
    expect(verified.mandate.binding).toEqual({
      principalId: ALICE_PRINCIPAL_ID,
      agentId: agent.principalId,
    });
    expect(verified.mandate.scope).toMatchObject({
      action: "document.read",
      ownerRelation: "self",
      clauseId: "PL-READ-SELF",
    });
    expect(verified.mandate.commitments.revision).toBe(1);
  });

  it("rejects a schema-valid payload changed after signing", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const claims = test.principalLatch.passportBroker.verifyAuthorization(
      "AgentPassport " + credential.passport,
    ).claims;
    await test.store.mutate((database) => {
      database.authorityRecords[0]!.mandate.binding.principalId = "user:bob";
    });

    await expect(
      test.principalLatch.authority.verifyCurrent(claims),
    ).rejects.toMatchObject({ code: "DENY_MANDATE_SIGNATURE" });
  });

  it("rejects a correctly re-signed profile commitment that differs from installed policy", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const claims = test.principalLatch.passportBroker.verifyAuthorization(
      "AgentPassport " + credential.passport,
    ).claims;
    const record = test.principalLatch.authority.getCurrent(agent.mandateId)!;
    const changed = structuredClone(record.mandate);
    changed.commitments.profileSha256 = `sha256:${"00".repeat(32)}`;
    changed.signature = "";
    record.mandate = await signMandate(changed, test.keys.mandateSeed);
    await test.store.mutate((database) => {
      database.authorityRecords[0] = record;
    });

    await expect(
      test.principalLatch.authority.verifyCurrent(claims),
    ).rejects.toMatchObject({ code: "DENY_PROFILE_COMMITMENT" });
  });

  it("rejects future-issued and valid-until equality even when correctly signed", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const claims = test.principalLatch.passportBroker.verifyAuthorization(
      "AgentPassport " + credential.passport,
    ).claims;
    const at = new Date();
    const record = test.principalLatch.authority.getCurrent(agent.mandateId)!;
    const changed = structuredClone(record.mandate);
    changed.lifecycle.issuedAt = new Date(at.getTime() + 60_000).toISOString();
    changed.lifecycle.validUntil = new Date(at.getTime() + 120_000).toISOString();
    changed.signature = "";
    record.mandate = await signMandate(changed, test.keys.mandateSeed);
    await test.store.mutate((database) => {
      database.authorityRecords[0] = record;
    });
    await expect(
      test.principalLatch.authority.verifyCurrent(claims, at),
    ).rejects.toMatchObject({ code: "DENY_MANDATE_LIFECYCLE" });

    const equality = structuredClone(record);
    equality.mandate.lifecycle.issuedAt = new Date(
      at.getTime() - 60_000,
    ).toISOString();
    equality.mandate.lifecycle.validUntil = at.toISOString();
    equality.mandate.signature = "";
    equality.mandate = await signMandate(
      equality.mandate,
      test.keys.mandateSeed,
    );
    await test.store.mutate((database) => {
      database.authorityRecords[0] = equality;
    });
    await expect(
      test.principalLatch.authority.verifyCurrent(claims, at),
    ).rejects.toMatchObject({ code: "DENY_MANDATE_LIFECYCLE" });
  });

  it("increments the signed revision on revoke without replacing the active Passport", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const first = test.principalLatch.credentialForAgent(agent);
    await test.principalLatch.revoke(agent);
    const current = test.principalLatch.authority.getCurrent(agent.mandateId)!;

    expect(current.revision).toBe(2);
    expect(current.mandate.lifecycle.status).toBe("revoked");
    expect(current.mandate.lifecycle.revokedAt).not.toBeNull();
    expect(current.mandate.commitments.revision).toBe(2);
    expect(test.principalLatch.credentialForAgent(agent).passport).toBe(first.passport);
  });
});
