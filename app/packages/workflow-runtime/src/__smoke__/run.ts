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
      {
        // A non-storage createable type WITH a distilled create-field schema, so
        // codegen should type create({...}) instead of Record<string, string>.
        id: "worker",
        displayName: "Worker",
        pluralDisplayName: "Workers",
        outputs: [{ key: "url", label: "URL" }],
        supportsCreate: true,
        supportsUpdate: false,
        supportsDelete: true,
        createFields: [
          { key: "name", kind: "text", required: true },
          { key: "region", kind: "region-picker", required: false, options: ["wnam", "enam"] },
          // ssh-key-picker → typed from the caller's Infrawrench key names.
          { key: "sshPublicKey", kind: "ssh-key-picker", required: false },
        ],
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
  async deleteResource() {
    deleteCalls += 1;
  },
  async createResource(accountId, typeId) {
    // A created resource carries the SSH key attached at create time.
    return {
      id: `${accountId}:${typeId}:new-1`,
      pluginId: "cloudflare",
      resourceTypeId: typeId,
      accountId,
      displayName: "new",
      externalId: "new-1",
      fields: {},
      resolvedOutputs: {},
      sshKeyRef: "deploy-key",
    };
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
  async sshExec(params) {
    lastSshKeyId = params.sshKeyId ?? null;
    return {
      stdoutBase64: Buffer.from("hello world\n").toString("base64"),
      stderrBase64: "",
      code: 0,
    };
  },
  async sshStreamStart() {
    sshStreamReads = 0;
    return { streamId: "stream-1" };
  },
  async sshStreamRead() {
    // Emit two chunks ("foo", "bar") then signal done.
    sshStreamReads += 1;
    if (sshStreamReads === 1)
      return { dataBase64: Buffer.from("foo").toString("base64"), done: false };
    if (sshStreamReads === 2)
      return { dataBase64: Buffer.from("bar").toString("base64"), done: false };
    return { done: true, code: 0 };
  },
  async sshStreamClose() {},
  async sshProbe() {
    return true;
  },
};

let sshStreamReads = 0;
let deleteCalls = 0;
let lastSshKeyId: string | null = null;

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

// SSH: single combined call — full string result, streamed chunks, and probe.
await bucket.waitUntilReachable();
const sshOut = await bucket.ssh("echo hi", { sshKey: "k" });
infra.log("ssh out:", sshOut.trim());
let streamed = "";
for await (const chunk of bucket.ssh("tail -f log", { sshKey: "k", stream: true, encoding: "utf8" })) {
  streamed += chunk;
}
infra.log("ssh streamed:", streamed);

// Delete the resource by calling .delete() on its own handle.
await bucket.delete();

// A created resource remembers its attached SSH key — ssh() needs no sshKey.
const created = await cf.workers.create({ name: "w", region: "wnam", sshPublicKey: "deploy-key" });
await created.ssh("echo hi");

const prev = infra.metrics.runCount ?? 0;
infra.metrics.runCount = prev + 1;

await infra.output({ hello: cfg.hello, buckets: buckets.length, runCount: prev + 1, sshOut: sshOut.trim(), streamed });
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
    sshKeyNames: ["deploy-key", "ci-key"],
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
  // worker has createFields → create() is typed with real keys + a region union.
  const dtsHasTypedCreate =
    dts.includes('region?: "wnam" | "enam" | (string & {})') && dts.includes("name: string");
  // ssh API is on every resource (declared on WorkflowResource).
  const dtsHasSsh =
    dts.includes("ssh(command: string, opts?: SshExecOptions): Promise<string>") &&
    dts.includes("waitUntilReachable(opts?: {");
  // ssh-key-picker create field + ssh() auth key both suggest Infrawrench key names.
  const dtsSshKeyCreateOptions = dts.includes(
    'sshPublicKey?: "deploy-key" | "ci-key" | (string & {})',
  );
  const dtsSshKeyAuthOptions = dts.includes('sshKey?: "deploy-key" | "ci-key" | (string & {})');
  // .delete() is exposed on every resource handle.
  const dtsHasInstanceDelete = dts.includes("delete(): Promise<void>;");
  console.log("DTS exposes resource.delete():", dtsHasInstanceDelete);
  console.log("resource.delete() called host deleteResource:", deleteCalls === 1);
  // The last ssh() call was created.ssh("echo hi") with NO sshKey → it should
  // have used the key attached at create time (sshKeyRef "deploy-key").
  const createdSshUsedAttachedKey = lastSshKeyId === "deploy-key";
  console.log("created resource ssh() defaulted to attached key:", createdSshUsedAttachedKey);
  console.log("DTS types create() from create fields:", dtsHasTypedCreate);
  console.log("DTS exposes resource.ssh + waitUntilReachable:", dtsHasSsh);
  console.log("DTS ssh-key create field suggests key names:", dtsSshKeyCreateOptions);
  console.log("DTS ssh() sshKey suggests key names:", dtsSshKeyAuthOptions);
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

  const sshResult = result.output as { sshOut: string; streamed: string };
  console.log("SSH exec output:", JSON.stringify(sshResult.sshOut));
  console.log("SSH streamed output:", JSON.stringify(sshResult.streamed));

  const ok =
    result.status === "success" &&
    (result.output as { runCount: number }).runCount === 1 &&
    metrics["runCount"] === 1 &&
    sshResult.sshOut === "hello world" &&
    sshResult.streamed === "foobar" &&
    deleteCalls === 1 &&
    createdSshUsedAttachedKey &&
    dtsHasInstanceDelete &&
    dtsHasMetricProp &&
    dtsHasGroup &&
    dtsHasListMethod &&
    dtsHasGetStorage &&
    dtsHasCreateMethod &&
    dtsHasTypedCreate &&
    dtsHasSsh &&
    dtsSshKeyCreateOptions &&
    dtsSshKeyAuthOptions &&
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
