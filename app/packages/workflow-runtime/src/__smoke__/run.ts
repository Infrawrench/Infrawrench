/**
 * Standalone runtime smoke test for the workflow sandbox. Not a unit test —
 * run with `tsx src/__smoke__/run.ts` to validate the async host bridge,
 * prelude, metrics, logging, prompt-gating, and codegen against a fake host.
 */
import { generateInfraDts } from "../codegen.js";
import type { WorkflowHost } from "../host.js";
import { runWorkflow } from "../sandbox.js";
import { transpileWorkflow } from "../transpile.js";
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
        capabilities: {
          ssh: true,
          sftp: true,
          sql: true,
          kv: true,
          nosql: true,
          logs: true,
          describe: true,
          manifest: true,
          publish: true,
          metrics: true,
        },
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
    // Emit stdout ("foo\nbar\n"), then stderr ("oops\n"), then done.
    sshStreamReads += 1;
    if (sshStreamReads === 1)
      return { stdoutBase64: Buffer.from("foo\nbar\n").toString("base64"), done: false };
    if (sshStreamReads === 2)
      return { stderrBase64: Buffer.from("oops\n").toString("base64"), done: false };
    return { done: true, code: 0 };
  },
  async sshStreamClose() {},
  async sshProbe() {
    return true;
  },
  async query(_accountId, _resourceId, sql) {
    return { rows: [{ q: sql }], durationMs: 3 };
  },
  async kvGet(_accountId, _typeId, _resourceId, key) {
    return "kv:" + key;
  },
  async getLogs() {
    return { text: "log-line\n", containers: ["main"], activeContainer: "main" };
  },
  async describe() {
    return "described";
  },
  async importYaml() {
    return { applied: 2 };
  },
  async sftpList() {
    return [
      { key: "a.txt", name: "a.txt", size: 3, lastModified: "", isDirectory: false },
      { key: "sub", name: "sub", size: 0, lastModified: "", isDirectory: true },
    ];
  },
  async sftpGet(_params, path) {
    return { base64: Buffer.from("body:" + path).toString("base64") };
  },
  async sftpPut() {},
  async sftpMkdir() {},
  async sftpDelete() {},
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
// infra.log decodes a Uint8Array (e.g. raw bytes from sftp.get) as UTF-8 text.
await infra.log(new TextEncoder().encode("bytes-as-text"));
// infra.log awaits a promise argument first (pass an unawaited sftp.get straight in).
await infra.log(Promise.resolve("promised-line"));
await infra.log(bucket.sftp.get("/x.txt", { encoding: "utf8" }));
// Streaming ssh: split stdout/stderr; pass the object to infra.log to stream it.
const streams = bucket.ssh("run", { sshKey: "k", stream: true });
await infra.log(streams);

// Extended capabilities (plugin-client passthroughs).
const q = await bucket.query("select 1");
const kvv = await bucket.kv.get("foo");
const lg = await bucket.logs();
const desc = await bucket.describe();
const yaml = await cf.importYaml("kind: X");
// SFTP: list, write, read back.
const entries = await bucket.sftp.list("/");
await bucket.sftp.put("/x.txt", "hello");
const got = new TextDecoder().decode(await bucket.sftp.get("/x.txt"));
// { encoding: "utf8" } should resolve to a string directly (no decode needed).
const gotStr = await bucket.sftp.get("/x.txt", { encoding: "utf8" });
const gotStrIsString = typeof gotStr === "string" && gotStr === got;
const caps = { q: q.rows.length, kv: kvv, log: lg.text.trim(), desc, applied: yaml.applied, sftp: entries.length, got, gotStrIsString };

// Delete the resource by calling .delete() on its own handle.
await bucket.delete();

// A created resource remembers its attached SSH key — ssh() needs no sshKey.
const created = await cf.workers.create({ name: "w", region: "wnam", sshPublicKey: "deploy-key" });
await created.ssh("echo hi");

const prev = infra.metrics.runCount ?? 0;
infra.metrics.runCount = prev + 1;

await infra.output({ hello: cfg.hello, buckets: buckets.length, runCount: prev + 1, sshOut: sshOut.trim(), caps });
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
  // The group's methods return the per-type resource interface.
  const dtsHasGroup = dts.includes("readonly r2Buckets: {");
  const dtsHasListMethod = dts.includes("list(): Promise<Resource_cloudflare_r2_bucket[]>");
  const dtsHasGetStorage = dts.includes(
    "get(externalId: string): Promise<Resource_cloudflare_r2_bucket>",
  );
  // Per-type gating: the worker type (no caps) must NOT advertise ssh/kv/etc.
  const workerIface = dts.slice(
    dts.indexOf("interface Resource_cloudflare_worker"),
    dts.indexOf("interface Resource_cloudflare_worker") + 400,
  );
  const gatingOk =
    !workerIface.includes("ssh(") &&
    !workerIface.includes("readonly kv:") &&
    !workerIface.includes("readonly sftp:");
  const dtsHasSftp = dts.includes("readonly sftp: {");
  const dtsSftpGetStrOverload = dts.includes(
    'get(path: string, opts: SshExecOptions & { encoding: "utf8" }): Promise<string>;',
  );
  console.log("per-type gating (worker lacks ssh/kv/sftp):", gatingOk);
  console.log("DTS exposes resource.sftp on capable type:", dtsHasSftp);
  console.log("DTS sftp.get has utf8 string overload:", dtsSftpGetStrOverload);
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

  const sshResult = result.output as {
    sshOut: string;
    caps: {
      q: number;
      kv: string;
      log: string;
      desc: string;
      applied: number;
      sftp: number;
      got: string;
      gotStrIsString: boolean;
    };
  };
  console.log("SSH exec output:", JSON.stringify(sshResult.sshOut));
  const caps = sshResult.caps;
  const capsOk =
    caps.q === 1 &&
    caps.kv === "kv:foo" &&
    caps.log === "log-line" &&
    caps.desc === "described" &&
    caps.applied === 2 &&
    caps.sftp === 2 &&
    caps.got === "body:/x.txt" &&
    caps.gotStrIsString === true;
  console.log("extended caps (query/kv/logs/describe/importYaml/sftp):", capsOk);
  console.log("sftp.get({ encoding: 'utf8' }) returns a string:", caps.gotStrIsString);
  // infra.log(streams) should have emitted stdout lines at "info" and stderr at "error".
  const logHas = (level: string, message: string) =>
    result.logs.some((l) => l.level === level && l.message === message);
  const streamLoggedOk = logHas("info", "foo") && logHas("info", "bar") && logHas("error", "oops");
  console.log("infra.log(streams) split stdout(info)/stderr(error):", streamLoggedOk);
  console.log("infra.log(Uint8Array) decodes as UTF-8 text:", logHas("info", "bytes-as-text"));
  console.log("infra.log(Promise) awaits then logs:", logHas("info", "promised-line"));

  // --- debugger: line instrumentation + pause-at-breakpoint -----------------
  // Top-level statements are at lines 2, 3 (function decl), 6, 7; line 4 is
  // inside helper() and MUST NOT be instrumented.
  const DEBUG_SOURCE = [
    ``,
    `infra.log("a");`,
    `function helper() {`,
    `  infra.log("inside");`,
    `}`,
    `helper();`,
    `infra.log("b");`,
  ].join("\n");

  const transpiled = (await transpileWorkflow(DEBUG_SOURCE, { instrumentLines: true })).code;
  const transpileMarksTopLevel =
    transpiled.includes("__line(2)") && transpiled.includes("__line(7)");
  const transpileSkipsFnBody = !transpiled.includes("__line(4)");
  console.log("transpile instruments top-level lines:", transpileMarksTopLevel);
  console.log("transpile skips function body:", transpileSkipsFnBody);

  const seenLines: number[] = [];
  const debugHost: WorkflowHost = {
    ...host,
    async line(n) {
      seenLines.push(n);
      // Treat line 6 as a breakpoint: block briefly, then "resume".
      if (n === 6) await new Promise((r) => setTimeout(r, 5));
    },
  };
  const debugResult = await runWorkflow({
    source: DEBUG_SOURCE,
    host: debugHost,
    interactive: true,
    debug: true,
  });
  console.log("DEBUG run status:", debugResult.status, "lines:", JSON.stringify(seenLines));
  const debugLinesOk =
    debugResult.status === "success" && JSON.stringify(seenLines) === JSON.stringify([2, 3, 6, 7]);
  console.log("DEBUG line sequence + breakpoint pause:", debugLinesOk);

  const ok =
    result.status === "success" &&
    (result.output as { runCount: number }).runCount === 1 &&
    metrics["runCount"] === 1 &&
    sshResult.sshOut === "hello world" &&
    streamLoggedOk &&
    capsOk &&
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
    gatingOk &&
    dtsHasSftp &&
    dtsSshKeyCreateOptions &&
    dtsSshKeyAuthOptions &&
    dtsOmitsUpdate &&
    dtsHasNoFlat &&
    dtsHasNoCall &&
    dtsHasNoResources &&
    dtsHasNoStorageNs &&
    transpileMarksTopLevel &&
    transpileSkipsFnBody &&
    debugLinesOk &&
    promptResult.status === "failure";
  console.log(ok ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
  process.exit(ok ? 0 : 1);
}

void main();
