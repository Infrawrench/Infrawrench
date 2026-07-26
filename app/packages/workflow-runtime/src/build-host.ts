/**
 * Helper that builds a {@link WorkflowHost} from a plugin-client accessor plus a
 * few platform callbacks. This centralizes the mapping from plugin-base
 * `PluginClient` methods to the sandbox's dispatch operations so the web server,
 * the poller, and the Electron main process don't each reimplement it.
 *
 * Each platform supplies: how to enumerate accounts (`listPlugins`), how to get
 * a client for an account (`getClient`), how to read storage bytes
 * (`readStorageObject` — wired to the platform's StorageNodeDriver), and how to
 * persist metrics / raise prompts.
 */
import type { PluginClient, ResourceInstance } from "@infrawrench/plugin-base";

import type {
  ResourceInstanceLite,
  SftpEntryLite,
  SftpParamsLite,
  SshExecParamsLite,
  SshExecResultLite,
  SshProbeParamsLite,
  SshStreamChunkLite,
  StorageObjectBody,
  WorkflowHost,
} from "./host.js";
import type {
  MetricValue,
  PageResult,
  PageSpec,
  PromptSpec,
  WorkflowCostRow,
  WorkflowCostWriteResult,
  WorkflowPluginInfo,
} from "./types.js";

export interface ClientHostDeps {
  /** Accounts grouped by plugin (drives `infra.accounts`). */
  listPlugins(): Promise<WorkflowPluginInfo[]>;
  /** Resolve a live plugin client for an account in the current trust scope. */
  getClient(accountId: string): Promise<PluginClient>;
  /** Read a storage object's raw bytes (platform wires its StorageNodeDriver). */
  readStorageObject(accountId: string, bucket: string, key: string): Promise<Uint8Array>;
  getMetric(key: string): Promise<MetricValue>;
  setMetric(key: string, value: MetricValue): Promise<void>;
  /** Snapshot of all declared metrics' current values, keyed by metric key. */
  listMetrics(): Promise<Record<string, MetricValue>>;
  /** Raise an interactive prompt (only reached for interactive runs). */
  prompt(spec: PromptSpec): Promise<MetricValue>;

  /**
   * Optional pre-create/update transform of the raw `fields`. Used to resolve
   * field values that reference Infrawrench-managed resources (e.g. an
   * `ssh-key-picker` field given a key NAME → the key's public key) before the
   * plugin client sees them. Returns the rewritten fields and, when an SSH key
   * was attached by name, that key reference (`sshKeyRef`) so the created
   * resource can SSH with it implicitly.
   */
  transformCreateFields?(
    accountId: string,
    typeId: string,
    fields: Record<string, string>,
  ): Promise<{ fields: Record<string, string>; sshKeyRef?: string }>;

  /** Run an SSH command on a resource to completion (powers `resource.ssh`). */
  sshExec?(params: SshExecParamsLite): Promise<SshExecResultLite>;
  /** Begin a streaming SSH command; returns a read token. */
  sshStreamStart?(params: SshExecParamsLite): Promise<{ streamId: string }>;
  /** Read the next stdout chunk of a streaming command (or signal done). */
  sshStreamRead?(streamId: string): Promise<SshStreamChunkLite>;
  /** Tear down a streaming command early. */
  sshStreamClose?(streamId: string): Promise<void>;
  /** Poll until the resource accepts SSH connections, or time out. */
  sshProbe?(params: SshProbeParamsLite): Promise<boolean>;

  /** SFTP operations (resolve the SSH config + run via a Node SFTP lib). */
  sftpList?(params: SftpParamsLite, path: string): Promise<SftpEntryLite[]>;
  sftpGet?(params: SftpParamsLite, path: string): Promise<{ base64: string }>;
  sftpPut?(params: SftpParamsLite, path: string, base64: string): Promise<void>;
  sftpMkdir?(params: SftpParamsLite, path: string): Promise<void>;
  sftpDelete?(params: SftpParamsLite, path: string, isDir: boolean): Promise<void>;

  /** Write daily spend into the org's cost store (cloud-only). */
  writeCosts?(rows: WorkflowCostRow[]): Promise<WorkflowCostWriteResult>;

  /** Deliver an alert and enforce its per-key cooldown (powers `infra.page`). */
  page?(spec: PageSpec): Promise<PageResult>;
  /** Re-arm a page key so the next page under it delivers immediately. */
  clearPage?(key: string): Promise<void>;

  /** Debugger line hook (instrumented runs); may block to pause at a breakpoint. */
  line?(line: number): Promise<void>;
}

/** Compose the canonical resource id used by plugin clients. */
function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

function toLite(instance: ResourceInstance): ResourceInstanceLite {
  return {
    id: instance.id,
    pluginId: instance.pluginId,
    resourceTypeId: instance.resourceTypeId,
    accountId: instance.accountId,
    displayName: instance.displayName,
    ...(instance.externalId !== undefined ? { externalId: instance.externalId } : {}),
    fields: instance.fields ?? {},
    resolvedOutputs: instance.resolvedOutputs ?? {},
  };
}

function bytesToBody(bytes: Uint8Array): StorageObjectBody {
  let base64: string;
  let text: string;
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(bytes);
    base64 = buf.toString("base64");
    text = buf.toString("utf8");
  } else {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    base64 = btoa(binary);
    text = new TextDecoder().decode(bytes);
  }
  return { base64, text };
}

export function buildWorkflowHost(deps: ClientHostDeps): WorkflowHost {
  return {
    listPlugins: () => deps.listPlugins(),

    async listResources(accountId, typeId) {
      const client = await deps.getClient(accountId);
      const list = await client.listResources(typeId, accountId);
      return list.map(toLite);
    },

    async getResource(accountId, typeId, externalId) {
      const client = await deps.getClient(accountId);
      const instance = await client.getResource(
        typeId,
        resourceId(accountId, typeId, externalId),
        accountId,
      );
      return toLite(instance);
    },

    async resolveOutput(accountId, typeId, rid, outputKey) {
      const client = await deps.getClient(accountId);
      return client.resolveOutput(typeId, rid, outputKey, accountId);
    },

    async createResource(accountId, typeId, fields, parentResourceId) {
      const client = await deps.getClient(accountId);
      if (!client.createResource) {
        throw new Error(`Plugin for account ${accountId} cannot create ${typeId}.`);
      }
      const transformed = deps.transformCreateFields
        ? await deps.transformCreateFields(accountId, typeId, fields)
        : { fields };
      const result = await client.createResource(
        typeId,
        accountId,
        transformed.fields,
        parentResourceId,
      );
      // `createResource` returns `ResourceCreateReturn`: either a bare
      // `ResourceInstance` or a `{ resource, warnings }` envelope.
      const instance = "resource" in result ? result.resource : result;
      const lite = toLite(instance);
      // Remember the SSH key attached at create time so resource.ssh() can use
      // it without the author repeating it.
      if (transformed.sshKeyRef) lite.sshKeyRef = transformed.sshKeyRef;
      return lite;
    },

    async updateResource(accountId, typeId, rid, fields) {
      const client = await deps.getClient(accountId);
      if (!client.updateResource) {
        throw new Error(`Plugin for account ${accountId} cannot update ${typeId}.`);
      }
      const transformed = deps.transformCreateFields
        ? await deps.transformCreateFields(accountId, typeId, fields)
        : { fields };
      const instance = await client.updateResource(typeId, rid, accountId, transformed.fields);
      return toLite(instance);
    },

    async deleteResource(accountId, typeId, rid) {
      const client = await deps.getClient(accountId);
      if (!client.deleteResource) {
        throw new Error(`Plugin for account ${accountId} cannot delete ${typeId}.`);
      }
      await client.deleteResource(typeId, rid, accountId);
    },

    async listStorageObjects(accountId, bucket, prefix) {
      const client = await deps.getClient(accountId);
      if (!client.listStorageObjects) {
        throw new Error(`Plugin for account ${accountId} has no storage browser.`);
      }
      const objects = await client.listStorageObjects(bucket, prefix);
      return objects.map((o) => ({
        key: o.key,
        name: o.name,
        size: o.size,
        lastModified: o.lastModified,
        isDirectory: o.isDirectory,
      }));
    },

    async readStorageObject(accountId, bucket, key) {
      const bytes = await deps.readStorageObject(accountId, bucket, key);
      return bytesToBody(bytes);
    },

    prompt: (spec) => deps.prompt(spec),
    getMetric: (key) => deps.getMetric(key),
    setMetric: (key, value) => deps.setMetric(key, value),
    listMetrics: () => deps.listMetrics(),

    // --- extended capabilities (plugin-client passthroughs) ----------------
    async query(accountId, resourceId, sql) {
      const client = await deps.getClient(accountId);
      if (!client.executeQuery) {
        throw new Error(`This resource does not support query() (no REST query engine).`);
      }
      return client.executeQuery(resourceId, accountId, sql);
    },
    async kvList(accountId, typeId, resourceId, params) {
      const client = await deps.getClient(accountId);
      if (!client.listKvKeys)
        throw new Error(`This resource does not support a key-value browser.`);
      const r = await client.listKvKeys(typeId, resourceId, accountId, params);
      return {
        items: r.items.map((k) => ({ key: k.name })),
        ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}),
      };
    },
    async kvGet(accountId, typeId, resourceId, key) {
      const client = await deps.getClient(accountId);
      if (!client.getKvValue)
        throw new Error(`This resource does not support a key-value browser.`);
      return client.getKvValue(typeId, resourceId, accountId, key);
    },
    async kvPut(accountId, typeId, resourceId, key, value) {
      const client = await deps.getClient(accountId);
      if (!client.putKvValue) throw new Error(`This resource does not support key-value writes.`);
      await client.putKvValue(typeId, resourceId, accountId, key, value);
    },
    async kvDelete(accountId, typeId, resourceId, key) {
      const client = await deps.getClient(accountId);
      if (!client.deleteKvKey) throw new Error(`This resource does not support key-value deletes.`);
      await client.deleteKvKey(typeId, resourceId, accountId, key);
    },
    async nosql(accountId, typeId, resourceId, command, args) {
      const client = await deps.getClient(accountId);
      if (!client.executeNoSqlCommand)
        throw new Error(`This resource does not support NoSQL commands.`);
      return client.executeNoSqlCommand(typeId, resourceId, accountId, command, args);
    },
    async getLogs(accountId, typeId, resourceId, params) {
      const client = await deps.getClient(accountId);
      if (!client.getLogs) throw new Error(`This resource does not expose logs.`);
      return client.getLogs(typeId, resourceId, accountId, params);
    },
    async describe(accountId, typeId, resourceId) {
      const client = await deps.getClient(accountId);
      if (!client.describeResource) throw new Error(`This resource does not support describe().`);
      return client.describeResource(typeId, resourceId, accountId);
    },
    async getManifest(accountId, resourceId) {
      const client = await deps.getClient(accountId);
      if (!client.getManifest) throw new Error(`This resource does not expose a manifest.`);
      return client.getManifest(resourceId, accountId);
    },
    async applyManifest(accountId, resourceId, manifest) {
      const client = await deps.getClient(accountId);
      if (!client.applyManifest) throw new Error(`This resource does not support applyManifest().`);
      await client.applyManifest(resourceId, accountId, manifest);
    },
    async importYaml(accountId, yaml) {
      const client = await deps.getClient(accountId);
      if (!client.importYaml) throw new Error(`This account does not support importYaml().`);
      return client.importYaml(accountId, yaml);
    },
    async publish(accountId, typeId, resourceId, payload) {
      const client = await deps.getClient(accountId);
      if (!client.publishMessage) throw new Error(`This resource is not a pub/sub target.`);
      return client.publishMessage(typeId, resourceId, accountId, {
        body: payload.body,
        extras: payload.extras ?? {},
      });
    },
    async metricSeries(accountId, typeId, resourceId, timeRange) {
      const client = await deps.getClient(accountId);
      if (!client.fetchMetricSeries) throw new Error(`This resource does not expose metrics.`);
      return client.fetchMetricSeries(typeId, resourceId, accountId, timeRange);
    },

    // SSH capabilities are forwarded only when the platform supplies them; when
    // absent, dispatch surfaces a WorkflowCapabilityError to the workflow.
    ...(deps.sshExec ? { sshExec: deps.sshExec } : {}),
    ...(deps.sshStreamStart ? { sshStreamStart: deps.sshStreamStart } : {}),
    ...(deps.sshStreamRead ? { sshStreamRead: deps.sshStreamRead } : {}),
    ...(deps.sshStreamClose ? { sshStreamClose: deps.sshStreamClose } : {}),
    ...(deps.sshProbe ? { sshProbe: deps.sshProbe } : {}),
    ...(deps.sftpList ? { sftpList: deps.sftpList } : {}),
    ...(deps.sftpGet ? { sftpGet: deps.sftpGet } : {}),
    ...(deps.sftpPut ? { sftpPut: deps.sftpPut } : {}),
    ...(deps.sftpMkdir ? { sftpMkdir: deps.sftpMkdir } : {}),
    ...(deps.sftpDelete ? { sftpDelete: deps.sftpDelete } : {}),
    ...(deps.writeCosts ? { writeCosts: deps.writeCosts } : {}),
    ...(deps.page ? { page: deps.page } : {}),
    ...(deps.clearPage ? { clearPage: deps.clearPage } : {}),
    ...(deps.line ? { line: deps.line } : {}),
  };
}
