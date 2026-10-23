import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Live network tests run only with LIVE=1.
    exclude: process.env.LIVE ? [] : ["test/live/**"],
    testTimeout: 30000,
  },
});
