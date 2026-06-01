/**
 * Standalone runtime smoke test for the workflow sandbox. Not a unit test —
 * run with `tsx src/__smoke__/run.ts` to validate the async host bridge,
 * prelude, metrics, logging, prompt-gating, and codegen against a fake host.
 */
import { generateInfraDts } from "../codegen.js";
import type { WorkflowHost } from "../host.js";
import { runWorkflow } from "../sandbox.js";
import type { MetricValue, WorkflowPluginInfo } from "../types.js";

const PLUGINS: WorkflowPluginInfo[] = [
  {
    pluginId: "cloudflare",
    displayName: "Cloudflare",
    accounts: [{ id: "acc_cf1", pluginId: "cloudflare", displayName: "prod" }],
    resourceTypes: [
      {
        id: "r2-bucket",
        displayName: "R2 Bucket",
        pluralDisplayName: "R2 Buckets",
        outputs: [{ key: "endpoint", label: "Endpoint" }],
        supportsCreate: true,
        supportsUpdate: false,
        supportsDelete: true,
        storage: true,
      },
    ],
  },
];

const metrics: Record<string, MetricValue> = { runCount: 0 };

const host: WorkflowHost = {
  async listPlugins() {
    return PLUGINS;
  },
  async listResources(accountId, typeId) {
    return [
      {
        id: `${accountId}:${typeId}:my-bucket`,
        pluginId: "cloudflare",
        resourceTypeId: typeId,
        accountId,
        displayName: "my-bucket",
        externalId: "my-bucket",
        fields: {},
        resolvedOutputs: { endpoint: "https://example.r2.cloudflarestorage.com" },
      },
    ];
  },
  async getResource(accountId, typeId, externalId) {
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "cloudflare",
      resourceTypeId: typeId,
      accountId,
      displayName: externalId,
      externalId,
      fields: {},
      resolvedOutputs: {},
    };
  },
  async resolveOutput() {
    return "resolved-value";
  },
  async listStorageObjects() {
    return [
      { key: "config.json", name: "config.json", size: 12, lastModified: "", isDirectory: false },
    ];
  },
  async readStorageObject() {
    const text = JSON.stringify({ hello: "world", n: 42 });
    return { base64: Buffer.from(text).toString("base64"), text };
  },
  async prompt() {
    throw new Error("prompt should not be called in this test");
  },
  async getMetric(key) {
    return metrics[key] ?? null;
  },
  async setMetric(key, value) {
    metrics[key] = value;
  },
  async listMetrics() {
    return { ...metrics };
  },
};

const SOURCE = `
const cf = infra.accounts.cloudflare.getByName("prod");
infra.log("account id:", cf.id);

// Grouped per-resource-type accessor (replaces the old generic .call).
const buckets = await cf.r2Buckets.list();
infra.log("bucket count:", buckets.length);

// Storage reads now hang off the bucket resource itself (no .storage namespace).
const bucket = await cf.r2Buckets.get("my-bucket");
const body = await bucket.get("config.json");
const cfg = body.json<{ hello: string; n: number }>();
infra.log("config.hello:", cfg.hello);

const prev = infra.metrics.runCount ?? 0;
infra.metrics.runCount = prev + 1;

await infra.output({ hello: cfg.hello, buckets: buckets.length, runCount: prev + 1 });
`;

async function main() {
  const result = await runWorkflow({ source: SOURCE, host, interactive: true });
  console.log("STATUS:", result.status);
  console.log(
    "LOGS:",
    JSON.stringify(
      result.logs.map((l) => `${l.level}: ${l.message}`),
      null,
      2,
    ),
  );
  console.log("OUTPUT:", JSON.stringify(result.output));
  console.log("ERROR:", JSON.stringify(result.error));
  console.log("METRIC runCount:", metrics["runCount"]);

  // Prompt gating in non-interactive mode.
  const promptResult = await runWorkflow({
    source: `await infra.prompt("hi");`,
    host,
    interactive: false,
  });
  console.log(
    "NONINTERACTIVE PROMPT STATUS:",
    promptResult.status,
    "->",
    promptResult.error?.message,
  );

  // Codegen sanity.
  const dts = generateInfraDts({
    plugins: PLUGINS,
    metrics: [{ key: "runCount", label: "Run count", type: "number" }],
  });
  console.log("DTS has getByName(prod):", dts.includes('getByName(name: "prod" | (string & {}))'));
  console.log("DTS has getById(acc_cf1):", dts.includes('getById(id: "acc_cf1" | (string & {}))'));
  const dtsHasMetricProp = dts.includes("runCount: number | null;");
  console.log("DTS has typed metric property:", dtsHasMetricProp);
  // r2-bucket is storage-capable → the group's methods return StorageResource.
  const dtsHasGroup = dts.includes("readonly r2Buckets: {");
  const dtsHasListMethod = dts.includes("list(): Promise<StorageResource[]>");
  const dtsHasGetStorage = dts.includes("get(externalId: string): Promise<StorageResource>");
  const dtsHasCreateMethod = dts.includes("create(fields: Record<string, string>");
  const dtsOmitsUpdate = !dts.includes("update(resourceId"); // r2-bucket has supportsUpdate=false
  const dtsHasNoFlat = !dts.includes("getR2Bucket") && !dts.includes("listR2Buckets");
  const dtsHasNoCall = !dts.includes("call<T = unknown>");
  const dtsHasNoResources = !dts.includes("readonly resources:");
  const dtsHasNoStorageNs = !dts.includes("readonly storage:");
  console.log("DTS has r2Buckets group:", dtsHasGroup);
  console.log("DTS group.list returns StorageResource[]:", dtsHasListMethod);
  console.log("DTS group.get returns StorageResource:", dtsHasGetStorage);
  console.log("DTS group has create:", dtsHasCreateMethod);
  console.log("DTS group omits update (read-only op):", dtsOmitsUpdate);
  console.log("DTS has no flat get/listR2Bucket:", dtsHasNoFlat);
  console.log(
    "DTS dropped .call/.resources/.storage:",
    dtsHasNoCall && dtsHasNoResources && dtsHasNoStorageNs,
  );

  const ok =
    result.status === "success" &&
    (result.output as { runCount: number }).runCount === 1 &&
    metrics["runCount"] === 1 &&
    dtsHasMetricProp &&
    dtsHasGroup &&
    dtsHasListMethod &&
    dtsHasGetStorage &&
    dtsHasCreateMethod &&
    dtsOmitsUpdate &&
    dtsHasNoFlat &&
    dtsHasNoCall &&
    dtsHasNoResources &&
    dtsHasNoStorageNs &&
    promptResult.status === "failure";
  console.log(ok ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
  process.exit(ok ? 0 : 1);
}

void main();
