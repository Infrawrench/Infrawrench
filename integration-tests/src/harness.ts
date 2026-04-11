/**
 * Integration test harness — runs real API calls against live provider accounts.
 * Each test is a focused assertion. Failures are collected and reported at the end.
 */

import type { Plugin, PluginClient, ResourceInstance } from "@infrawrench/plugin-base";
import {
  pluginManifestSchema,
  detailViewSchema,
} from "@infrawrench/plugin-base";
import { buildHostServices } from "./host-services.js";

export interface TestResult {
  pluginId: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const results: TestResult[] = [];

const TEST_TIMEOUT_MS = 30_000;

async function runTest(pluginId: string, name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS),
      ),
    ]);
    const duration = performance.now() - start;
    results.push({ pluginId, name, passed: true, durationMs: duration });
    process.stdout.write(`    ✓ ${name} (${Math.round(duration)}ms)\n`);
  } catch (err) {
    const duration = performance.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ pluginId, name, passed: false, durationMs: duration, error: message });
    process.stdout.write(`    ✗ ${name} (${Math.round(duration)}ms)\n`);
    process.stdout.write(`      → ${message}\n`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export async function runPluginIntegrationTests(
  plugin: Plugin,
  credentials: Record<string, string>,
): Promise<void> {
  const pid = plugin.manifest.id;
  process.stdout.write(`\n  ${plugin.manifest.displayName} (${pid})\n`);

  // 1. Manifest validation (quick sanity)
  await runTest(pid, "manifest passes Zod validation", async () => {
    const result = pluginManifestSchema.safeParse(plugin.manifest);
    assert(result.success, `Manifest validation failed: ${JSON.stringify(result.error?.issues)}`);
  });

  // 2. Client creation (with host services for driver-backed plugins)
  let client: PluginClient;
  await runTest(pid, "createClient succeeds with real credentials", async () => {
    const services = buildHostServices(plugin, credentials);
    client = plugin.createClient(credentials, services);
    assert(client !== undefined, "createClient returned undefined");
  });

  if (!client!) return;

  // 3. listResources for each resource type
  const resourcesByType = new Map<string, ResourceInstance[]>();

  for (const rt of plugin.resourceTypes) {
    await runTest(pid, `listResources("${rt.id}") returns array`, async () => {
      const resources = await client.listResources(rt.id, `integration-${pid}`);
      assert(Array.isArray(resources), `Expected array, got ${typeof resources}`);
      resourcesByType.set(rt.id, resources);
    });
  }

  // 4. For each type that returned resources, test getResource, renderDetail, renderSidebarItem
  for (const rt of plugin.resourceTypes) {
    const resources = resourcesByType.get(rt.id) ?? [];
    if (resources.length === 0) continue;

    const first = resources[0]!;

    await runTest(pid, `getResource("${rt.id}", "${first.id}") returns instance`, async () => {
      const resource = await client.getResource(rt.id, first.id, first.accountId);
      assert(resource !== undefined, "getResource returned undefined");
      assert(typeof resource.id === "string", "resource.id is not a string");
      assert(resource.id === first.id, `resource.id mismatch: ${resource.id} !== ${first.id}`);
    });

    await runTest(pid, `renderDetail for ${rt.id}/${first.id} returns valid schema`, async () => {
      const detail = client.renderDetail(first);
      assert(detail !== undefined, "renderDetail returned undefined");
      const validation = detailViewSchema.safeParse(detail);
      assert(validation.success, `DetailView validation failed: ${JSON.stringify(validation.error?.issues?.slice(0, 3))}`);
    });

    await runTest(pid, `renderSidebarItem for ${rt.id}/${first.id} returns {id, label}`, async () => {
      const item = client.renderSidebarItem(first);
      assert(item !== undefined, "renderSidebarItem returned undefined");
      assert(typeof item.id === "string" && item.id.length > 0, "sidebar item.id is empty");
      assert(typeof item.label === "string" && item.label.length > 0, "sidebar item.label is empty");
    });
  }

  // 5. resolveOutput — test on first available resource that has outputs defined
  for (const rt of plugin.resourceTypes) {
    const resources = resourcesByType.get(rt.id) ?? [];
    if (resources.length === 0) continue;
    if (!rt.outputs || rt.outputs.length === 0) continue;

    const first = resources[0]!;
    const firstOutput = rt.outputs[0]!;

    await runTest(pid, `resolveOutput("${rt.id}", "${firstOutput.key}")`, async () => {
      const value = await client.resolveOutput(rt.id, first.id, firstOutput.key, first.accountId);
      assert(typeof value === "string", `Expected string, got ${typeof value}`);
    });

    // Only test one output per plugin to keep things quick
    break;
  }

  // 6. Optional: introspect (for SQL-capable plugins)
  if (plugin.manifest.sqlDriver && typeof client.introspect === "function") {
    await runTest(pid, "introspect() returns table metadata", async () => {
      const tables = await client.introspect!();
      assert(Array.isArray(tables), `Expected array, got ${typeof tables}`);
    });
  }

  // 7. Optional: getCreateConfig (if any resource type supports create)
  const creatableType = plugin.resourceTypes.find((rt) => rt.supportsCreate);
  if (creatableType && typeof client.getCreateConfig === "function") {
    await runTest(pid, `getCreateConfig("${creatableType.id}") returns config`, async () => {
      const config = await client.getCreateConfig!(creatableType.id);
      assert(config !== undefined, "getCreateConfig returned undefined");
      assert(Array.isArray(config.fields), "config.fields is not an array");
    });
  }

  // 8. Optional: listStorageObjects (for storage-capable plugins)
  const storageType = plugin.resourceTypes.find((rt) => rt.supportsStorageBrowser);
  if (storageType && typeof client.listStorageObjects === "function") {
    const resources = resourcesByType.get(storageType.id) ?? [];
    if (resources.length > 0) {
      const bucket = resources[0]!;
      await runTest(pid, `listStorageObjects for ${storageType.id}`, async () => {
        const objects = await client.listStorageObjects!(bucket.displayName || bucket.id, "");
        assert(Array.isArray(objects), `Expected array, got ${typeof objects}`);
      });
    }
  }

  // 9. Optional: listNamespacesForImport (for secret-import-capable plugins)
  if (plugin.manifest.supportsSecretImport && typeof client.listNamespacesForImport === "function") {
    await runTest(pid, "listNamespacesForImport returns array", async () => {
      const namespaces = await client.listNamespacesForImport!(`integration-${pid}`);
      assert(Array.isArray(namespaces), `Expected array, got ${typeof namespaces}`);
    });
  }

  // 10. Optional: fetchStats (for driver-backed plugins)
  if (typeof client.fetchStats === "function") {
    await runTest(pid, "fetchStats returns { version, size, tableCount }", async () => {
      const stats = await client.fetchStats!();
      assert(typeof stats.version === "string", "stats.version is not a string");
      assert(typeof stats.size === "string", "stats.size is not a string");
      assert(typeof stats.tableCount === "number", "stats.tableCount is not a number");
    });
  }

  // 11. Optional: getSshConfig (for SSH-capable plugins)
  const terminalType = plugin.resourceTypes.find((rt) => rt.supportsTerminal);
  if (terminalType && typeof client.getSshConfig === "function") {
    await runTest(pid, "getSshConfig returns connection details", async () => {
      const config = client.getSshConfig!();
      assert(typeof config.host === "string", "sshConfig.host is not a string");
      assert(typeof config.port === "number", "sshConfig.port is not a number");
      assert(typeof config.username === "string", "sshConfig.username is not a string");
    });
  }

  // 12. Optional: introspectResource (for REST-based SQL providers like BigQuery)
  if (typeof client.introspectResource === "function") {
    for (const rt of plugin.resourceTypes) {
      const resources = resourcesByType.get(rt.id) ?? [];
      if (resources.length === 0) continue;
      const first = resources[0]!;
      await runTest(pid, `introspectResource("${rt.id}", "${first.id}")`, async () => {
        const tables = await client.introspectResource!(first.id, first.accountId);
        assert(Array.isArray(tables), `Expected array, got ${typeof tables}`);
      });
      break;
    }
  }

  // 13. Optional: getManifest (for manifest-capable plugins)
  if (typeof client.getManifest === "function") {
    for (const rt of plugin.resourceTypes) {
      const resources = resourcesByType.get(rt.id) ?? [];
      if (resources.length === 0) continue;
      const first = resources[0]!;
      await runTest(pid, `getManifest("${rt.id}", "${first.id}")`, async () => {
        const manifest = await client.getManifest!(first.id, first.accountId);
        assert(typeof manifest === "string", `Expected string, got ${typeof manifest}`);
        assert(manifest.length > 0, "manifest is empty");
      });
      break;
    }
  }
}

export function getResults(): TestResult[] {
  return results;
}

export function printSummary(): { total: number; passed: number; failed: number; skipped: number } {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  process.stdout.write("\n─────────────────────────────────────────────────\n");
  process.stdout.write(`Integration tests: ${passed} passed, ${failed} failed, ${total} total\n`);

  if (failed > 0) {
    process.stdout.write("\nFailed tests:\n");
    for (const r of results.filter((r) => !r.passed)) {
      process.stdout.write(`  ✗ [${r.pluginId}] ${r.name}\n`);
      if (r.error) process.stdout.write(`    → ${r.error}\n`);
    }
  }

  return { total, passed, failed, skipped: 0 };
}

export function resetResults(): void {
  results.length = 0;
}
