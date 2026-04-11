#!/usr/bin/env tsx
/**
 * Integration test runner.
 *
 * Usage:
 *   # Run with env vars already exported:
 *   pnpm --filter @infrawrench/integration-tests test:integration
 *
 *   # Run with a .env file:
 *   env $(cat integration-tests/.env | xargs) pnpm --filter @infrawrench/integration-tests test:integration
 *
 *   # Run only specific providers:
 *   INTEGRATION_PLUGINS=neon,hetzner pnpm --filter @infrawrench/integration-tests test:integration
 *
 * Exit code 0 = all tested providers passed (or none were configured).
 * Exit code 1 = at least one test failed.
 */

import { resolveCredentials, allPluginIds } from "./credentials.js";
import { pluginMap } from "./plugins.js";
import { runPluginIntegrationTests, printSummary, resetResults } from "./harness.js";

async function main(): Promise<void> {
  resetResults();

  process.stdout.write("╭──────────────────────────────────────────────────╮\n");
  process.stdout.write("│       Infrawrench Integration Tests              │\n");
  process.stdout.write("╰──────────────────────────────────────────────────╯\n\n");

  // Resolve which providers have credentials available
  const resolved = resolveCredentials();

  // Filter to specific plugins if INTEGRATION_PLUGINS is set
  const filterEnv = process.env["INTEGRATION_PLUGINS"];
  const allowedPlugins = filterEnv
    ? new Set(filterEnv.split(",").map((s) => s.trim()))
    : null;

  const toRun = allowedPlugins
    ? resolved.filter((r) => allowedPlugins.has(r.pluginId))
    : resolved;

  // Report skipped providers
  const allIds = allPluginIds();
  const runningIds = new Set(toRun.map((r) => r.pluginId));
  const skippedIds = allIds.filter((id) => !runningIds.has(id));

  if (skippedIds.length > 0) {
    process.stdout.write(`Skipping (no credentials): ${skippedIds.join(", ")}\n`);
  }

  if (toRun.length === 0) {
    process.stdout.write("\nNo providers configured. Set env vars and try again.\n");
    process.stdout.write("See integration-tests/.env.example for the full list.\n");
    process.exit(0);
  }

  process.stdout.write(`\nTesting ${toRun.length} provider(s): ${toRun.map((r) => r.pluginId).join(", ")}\n`);

  // Run tests sequentially per provider (parallel within a provider would be chaos)
  for (const { pluginId, credentials } of toRun) {
    const plugin = pluginMap[pluginId];
    if (!plugin) {
      process.stdout.write(`\n  ⚠ No plugin module found for "${pluginId}" — skipping\n`);
      continue;
    }

    try {
      await runPluginIntegrationTests(plugin, credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n  ✗ [${pluginId}] Fatal error: ${message}\n`);
    }
  }

  // Print summary and exit
  const { failed } = printSummary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test runner crashed:", err);
  process.exit(2);
});
