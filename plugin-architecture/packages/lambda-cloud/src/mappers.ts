import type { ResourceInstance } from "@infrawrench/plugin-base";
import { formatRules, openToInternet, sshOpenToInternet } from "./firewall.js";
import type { LFilesystem, LFirewallRuleset, LInstance, LSshKey } from "./types.js";

/** Pure mapping from Lambda Cloud payloads to host resource instances. */

export const PLUGIN_ID = "lambda-cloud";
export const GLOBAL_FIREWALL_ID = "global";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  createdAt?: string;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

function joinList(values: Array<string | undefined | null> | undefined): string {
  return (values ?? []).filter((v): v is string => !!v).join(", ");
}

export function formatTags(tags: Array<{ key: string; value: string }> | undefined): string {
  return (tags ?? []).map((t) => `${t.key}=${t.value}`).join(", ");
}

/** `a=1, b=2` → tag entries. Reserved `lambda-ai-` keys are dropped: Lambda rejects them. */
export function parseTags(text: string | undefined): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const part of (text ?? "").split(/[,\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    const key = (eq < 0 ? p : p.slice(0, eq)).trim();
    if (!key || key.startsWith("lambda-ai-")) continue;
    out.push({ key, value: eq < 0 ? "" : p.slice(eq + 1).trim() });
  }
  return out;
}

export function mapInstance(i: LInstance, accountId: string): ResourceInstance {
  const t = i.instance_type;
  const restart = i.actions?.restart;
  const ip = i.ip ?? "";
  return makeInstance({
    accountId,
    typeId: "instance",
    externalId: i.id,
    displayName: i.name || t?.name || i.id,
    fields: {
      name: i.name ?? "",
      status: i.status ?? "",
      region: i.region?.name ?? "",
      regionName: i.region?.description ?? "",
      instanceType: t?.name ?? "",
      gpuDescription: t?.gpu_description ?? "",
      gpus: t?.specs?.gpus ?? 0,
      vcpus: t?.specs?.vcpus ?? 0,
      memoryGib: t?.specs?.memory_gib ?? 0,
      storageGib: t?.specs?.storage_gib ?? 0,
      architecture: t?.architecture ?? "",
      pricePerHour: (t?.price_cents_per_hour ?? 0) / 100,
      imageFamily: i.image?.family ?? "",
      sshKeyNames: joinList(i.ssh_key_names),
      filesystemIds: joinList((i.file_system_mounts ?? []).map((m) => m.file_system_id)),
      firewallRulesetIds: joinList((i.firewall_rulesets ?? []).map((r) => r.id)),
      tags: formatTags(i.tags),
      hostname: i.hostname ?? "",
      firstHealthy: i.first_healthy ?? "",
      restartBlocked:
        restart && restart.available === false
          ? restart.reason_description || restart.reason_code || "unavailable"
          : "",
    },
    outputs: {
      ip,
      privateIp: i.private_ip ?? "",
      sshCommand: ip ? `ssh ubuntu@${ip}` : "",
      // The Jupyter URL and token are credentials: never stored with the
      // inventory, fetched on demand by resolveOutput.
    },
  });
}

export function mapFilesystem(fs: LFilesystem, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "filesystem",
    externalId: fs.id,
    displayName: fs.name || fs.id,
    fields: {
      name: fs.name ?? "",
      region: fs.region?.name ?? "",
      mountPoint: fs.mount_point ?? "",
      inUse: fs.is_in_use ?? false,
      usedGb: typeof fs.bytes_used === "number" ? Math.round((fs.bytes_used / 1e9) * 100) / 100 : 0,
      createdBy: fs.created_by?.email ?? "",
      createdAt: fs.created ?? "",
    },
    ...(fs.created ? { createdAt: fs.created } : {}),
  });
}

export function mapRuleset(
  r: LFirewallRuleset,
  accountId: string,
  global = false,
): ResourceInstance {
  const fields: Fields = {
    name: r.name ?? (global ? "Global" : ""),
    rules: formatRules(r.rules),
    ruleCount: r.rules?.length ?? 0,
    openToInternet: openToInternet(r.rules),
    sshOpenToInternet: sshOpenToInternet(r.rules),
  };
  if (!global) {
    fields["region"] = r.region?.name ?? "";
    fields["instanceIds"] = joinList(r.instance_ids);
    fields["createdAt"] = r.created ?? "";
  }
  return makeInstance({
    accountId,
    typeId: global ? "global-firewall" : "firewall-ruleset",
    externalId: global ? GLOBAL_FIREWALL_ID : r.id,
    displayName: global ? "Global firewall rules" : r.name || r.id,
    fields,
    ...(r.created ? { createdAt: r.created } : {}),
  });
}

export function mapSshKey(k: LSshKey, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "ssh-key",
    externalId: k.id,
    displayName: k.name || k.id,
    fields: { name: k.name ?? "", publicKey: k.public_key ?? "" },
  });
}
