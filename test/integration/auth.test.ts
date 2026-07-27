import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { generateApiKey } from "../../src/auth/api-keys.js";
import { authenticateAgentByApiKey, getOrCreateGithubAgentIdentity } from "../../src/auth/authenticate-agent.js";
import { createSession, authenticateSession, revokeSession } from "../../src/auth/sessions.js";
import { AuthorizationError } from "../../src/domain/errors.js";

describe("authenticateAgentByApiKey", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("authenticates a valid, unrevoked key and updates lastUsedAt", async () => {
    const fx = await createFixtures();
    const key = generateApiKey();
    await testPrisma.apiKeyCredential.create({
      data: { agentIdentityId: fx.agentIdentityId, keyPrefix: key.prefix, keyHash: key.hash },
    });

    const agent = await authenticateAgentByApiKey(testPrisma, key.raw);
    expect(agent.agentIdentityId).toBe(fx.agentIdentityId);
    expect(agent.organizationId).toBe(fx.organizationId);
    expect(agent.permissions.maxConcurrentRuns).toBe(5);

    const updated = await testPrisma.agentIdentity.findUniqueOrThrow({ where: { id: fx.agentIdentityId } });
    expect(updated.lastUsedAt).not.toBeNull();
  });

  it("rejects an unknown key", async () => {
    await createFixtures();
    await expect(authenticateAgentByApiKey(testPrisma, generateApiKey().raw)).rejects.toThrow(AuthorizationError);
  });

  it("rejects a revoked key", async () => {
    const fx = await createFixtures();
    const key = generateApiKey();
    await testPrisma.apiKeyCredential.create({
      data: {
        agentIdentityId: fx.agentIdentityId,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        revokedAt: new Date(),
      },
    });
    await expect(authenticateAgentByApiKey(testPrisma, key.raw)).rejects.toThrow(AuthorizationError);
  });

  it("rejects a malformed bearer token without querying the database", async () => {
    await expect(authenticateAgentByApiKey(testPrisma, "totally-not-a-key")).rejects.toThrow(AuthorizationError);
  });

  it("getOrCreateGithubAgentIdentity is idempotent per organization", async () => {
    const fx = await createFixtures();
    const first = await getOrCreateGithubAgentIdentity(testPrisma, fx.organizationId);
    const second = await getOrCreateGithubAgentIdentity(testPrisma, fx.organizationId);
    expect(second.agentIdentityId).toBe(first.agentIdentityId);
  });
});

describe("dashboard sessions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates and authenticates a session", async () => {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    const user = await testPrisma.user.create({
      data: { organizationId: org.id, email: "founder@acme.test", role: "owner" },
    });

    const session = await createSession(testPrisma, user.id);
    const authed = await authenticateSession(testPrisma, session.token);
    expect(authed.userId).toBe(user.id);
    expect(authed.organizationId).toBe(org.id);
    expect(authed.role).toBe("owner");
  });

  it("rejects a revoked session", async () => {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    const user = await testPrisma.user.create({
      data: { organizationId: org.id, email: "founder@acme.test", role: "owner" },
    });
    const session = await createSession(testPrisma, user.id);
    await revokeSession(testPrisma, session.token);
    await expect(authenticateSession(testPrisma, session.token)).rejects.toThrow(AuthorizationError);
  });

  it("rejects an unknown session token", async () => {
    await expect(authenticateSession(testPrisma, "bogus-token")).rejects.toThrow(AuthorizationError);
  });
});
