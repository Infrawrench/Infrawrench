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
};

const SOURCE = `
const cf = infra.accounts.cloudflare.getByName("prod");
infra.log("account id:", cf.id);

const buckets = await cf.resources["r2-bucket"].list();
infra.log("bucket count:", buckets.length);

const body = await cf.storage.bucket("my-bucket").get("config.json");
const cfg = body.json<{ hello: string; n: number }>();
infra.log("config.hello:", cfg.hello);

const prev = (await infra.metrics.get("runCount")) ?? 0;
await infra.metrics.set("runCount", prev + 1);

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
  console.log("DTS has getByName(prod):", dts.includes('getByName(name: "prod")'));
  console.log("DTS has r2-bucket handle:", dts.includes('"r2-bucket": ResourceHandle'));
  console.log(
    "DTS has metric overload:",
    dts.includes('get(key: "runCount"): Promise<number | null>'),
  );

  const ok =
    result.status === "success" &&
    (result.output as { runCount: number }).runCount === 1 &&
    metrics["runCount"] === 1 &&
    promptResult.status === "failure";
  console.log(ok ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
  process.exit(ok ? 0 : 1);
}

void main();
