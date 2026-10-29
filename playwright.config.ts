// Drives the demo page in a real browser, against the real Worker under `wrangler dev`. Run `npm run test:ui`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { TOKENS } from "./e2e/tokens.js";

export const PORT = 8893;
const dir = mkdtempSync(join(tmpdir(), "comments-ui-"));
const config = join(dir, "wrangler.jsonc");
writeFileSync(
  config,
  JSON.stringify({
    name: "comments-ui-e2e",
    main: resolve("src/worker.ts"),
    compatibility_date: "2026-01-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: resolve("public/ui"), run_worker_first: ["/api/*", "/health"] },
    d1_databases: [{ binding: "DB", database_name: "comments-ui-e2e", database_id: "00000000-0000-0000-0000-000000000000" }],
    vars: { AGENTIC_COMMENTS_REGION: "unknown", AGENTIC_COMMENTS_UNSAFE_REGION: "1", AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS: "1", AGENTIC_COMMENTS_TOKENS: JSON.stringify(TOKENS) },
  }),
);

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.ui.spec.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1280, height: 900 }, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `node ${resolve("node_modules/wrangler/bin/wrangler.js")} dev --config ${config} --ip 127.0.0.1 --port ${PORT} --inspector-port ${PORT + 100} --local --persist-to ${join(dir, "state")}`,
    url: `http://127.0.0.1:${PORT}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
});
