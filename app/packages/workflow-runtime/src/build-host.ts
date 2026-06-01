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
  SshExecParamsLite,
  SshExecResultLite,
  SshProbeParamsLite,
  SshStreamChunkLite,
  StorageObjectBody,
  WorkflowHost,
} from "./host.js";
import type { MetricValue, PromptSpec, WorkflowPluginInfo } from "./types.js";

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
      const instance =
        result && typeof result === "object" && "resource" in result
          ? (result as { resource: ResourceInstance }).resource
          : (result as unknown as ResourceInstance);
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

    // SSH capabilities are forwarded only when the platform supplies them; when
    // absent, dispatch surfaces a WorkflowCapabilityError to the workflow.
    ...(deps.sshExec ? { sshExec: deps.sshExec } : {}),
    ...(deps.sshStreamStart ? { sshStreamStart: deps.sshStreamStart } : {}),
    ...(deps.sshStreamRead ? { sshStreamRead: deps.sshStreamRead } : {}),
    ...(deps.sshStreamClose ? { sshStreamClose: deps.sshStreamClose } : {}),
    ...(deps.sshProbe ? { sshProbe: deps.sshProbe } : {}),
    ...(deps.line ? { line: deps.line } : {}),
  };
}
