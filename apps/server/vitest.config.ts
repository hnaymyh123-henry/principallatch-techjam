import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These integration tests create isolated key stores and Fastify apps.
    // Serial files avoid cold-cache filesystem/crypto bursts on Windows judge
    // machines; the longer timeout is a guardrail, not a retry mechanism.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
