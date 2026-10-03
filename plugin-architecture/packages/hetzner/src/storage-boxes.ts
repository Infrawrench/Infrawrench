import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { errorText, formBool, trailingId, type HetznerApi } from "./api.js";

/**
 * Storage Boxes, served by the Hetzner API (`api.hetzner.com/v1`, live since
 * 2025-06-25) rather than the Cloud API, but authenticated with the same
 * project API token. Sizes in the API are bytes.
 */

export interface HetznerStorageBox {
  id: number;
  name: string;
  created?: string;
  status?: string;
  username?: string | null;
  server?: string | null;
  storage_box_type?: { name?: string; size?: number };
  location?: { name?: string; city?: string };
  access_settings?: {
    reachable_externally?: boolean;
    samba_enabled?: boolean;
    ssh_enabled?: boolean;
    webdav_enabled?: boolean;
    zfs_enabled?: boolean;
  };
  snapshot_plan?: {
    max_snapshots?: number;
    minute?: number;
    hour?: number;
    day_of_week?: number | null;
    day_of_month?: number | null;
  } | null;
  protection?: { delete?: boolean };
  stats?: { size?: number; size_data?: number; size_snapshots?: number };
}

interface HetznerStorageBoxType {
  id: number;
  name: string;
  description?: string;
  size?: number;
  deprecation?: unknown;
  prices?: Array<{ location: string; price_monthly?: { net?: string; gross?: string } }>;
}

const BYTES_PER_GB = 1_000_000_000;
const ACCESS_KEYS: Array<[string, string]> = [
  ["sshEnabled", "ssh_enabled"],
  ["sambaEnabled", "samba_enabled"],
  ["webdavEnabled", "webdav_enabled"],
  ["zfsEnabled", "zfs_enabled"],
  ["reachableExternally", "reachable_externally"],
];

function gb(bytes: number | undefined): number {
  return bytes ? Math.round((bytes / BYTES_PER_GB) * 100) / 100 : 0;
}

function describePlan(plan: HetznerStorageBox["snapshot_plan"]): string {
  if (!plan) return "";
  const time = `${String(plan.hour ?? 0).padStart(2, "0")}:${String(plan.minute ?? 0).padStart(2, "0")} UTC`;
  const cadence =
    plan.day_of_month != null
      ? `monthly on day ${plan.day_of_month}`
      : plan.day_of_week != null
        ? `weekly on day ${plan.day_of_week}`
        : "daily";
  return `${cadence} at ${time}, keep ${plan.max_snapshots ?? 0}`;
}

export function mapStorageBox(b: HetznerStorageBox, accountId: string): ResourceInstance {
  const created = b.created ?? new Date().toISOString();
  const access = b.access_settings ?? {};
  return {
    id: `${accountId}:storage-box:${b.id}`,
    pluginId: "hetzner",
    resourceTypeId: "storage-box",
    accountId,
    displayName: b.name,
    fields: {
      name: b.name,
      status: b.status ?? "",
      storageBoxType: b.storage_box_type?.name ?? "",
      location: b.location?.name ?? "",
      username: b.username ?? "",
      server: b.server ?? "",
      sizeGb: gb(b.storage_box_type?.size),
      usedGb: gb(b.stats?.size),
      snapshotsGb: gb(b.stats?.size_snapshots),
      sshEnabled: access.ssh_enabled ?? false,
      sambaEnabled: access.samba_enabled ?? false,
      webdavEnabled: access.webdav_enabled ?? false,
      zfsEnabled: access.zfs_enabled ?? false,
      reachableExternally: access.reachable_externally ?? false,
      snapshotPlan: describePlan(b.snapshot_plan),
      deleteProtection: b.protection?.delete ?? false,
    },
    resolvedOutputs: { server: b.server ?? "", username: b.username ?? "" },
    secretStates: [],
    externalId: String(b.id),
    createdAt: created,
    updatedAt: created,
  };
}

export async function listStorageBoxes(
  api: HetznerApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const boxes = await api.fetchAllHetzner<HetznerStorageBox>("/storage_boxes", "storage_boxes");
  return boxes.map((b) => mapStorageBox(b, accountId));
}

export async function storageBoxCreateConfig(api: HetznerApi): Promise<CreateResourceConfig> {
  const types = await api.fetchAllHetzner<HetznerStorageBoxType>(
    "/storage_box_types",
    "storage_box_types",
  );
  const orderable = types.filter((t) => !t.deprecation);
  const locations = [...new Set(orderable.flatMap((t) => (t.prices ?? []).map((p) => p.location)))];
  const typeOptions = orderable.map((t) => {
    const price = t.prices?.[0]?.price_monthly?.gross;
    const size = t.size ? `${Math.round(t.size / 1024 ** 4)} TB` : "";
    return {
      id: t.name,
      label: [t.description || t.name, size, price ? `${Number(price).toFixed(2)}/mo gross` : ""]
        .filter(Boolean)
        .join(" · "),
    };
  });
  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "location",
        label: "Location",
        kind: "region-picker",
        required: true,
        regions: locations.map((l) => ({ id: l, label: l })),
        ...(locations[0] ? { defaultValue: locations[0] } : {}),
      },
      {
        key: "storageBoxType",
        label: "Type",
        kind: "select",
        required: true,
        options: typeOptions,
        ...(typeOptions[0] ? { defaultValue: typeOptions[0].id } : {}),
      },
      {
        key: "password",
        label: "Password",
        kind: "password",
        required: true,
        description: "At least 12 characters, including a special character",
      },
      { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
      {
        key: "sshEnabled",
        label: "SSH / SFTP access",
        kind: "select",
        required: false,
        defaultValue: "true",
        options: [
          { id: "true", label: "Enabled" },
          { id: "false", label: "Disabled" },
        ],
      },
      {
        key: "reachableExternally",
        label: "Reachable from outside Hetzner",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "true", label: "Yes" },
          { id: "false", label: "Only from Hetzner servers" },
        ],
      },
    ],
  };
}

export async function createStorageBox(
  api: HetznerApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const access: Record<string, boolean> = {};
  for (const [formKey, apiKey] of ACCESS_KEYS) {
    const v = formBool(fields[formKey]);
    if (v !== undefined) access[apiKey] = v;
  }
  const sshKey = fields["sshPublicKey"]?.trim();
  const data = await api.fetchHetzner<{ storage_box: HetznerStorageBox }>("/storage_boxes", {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"],
      location: fields["location"],
      storage_box_type: fields["storageBoxType"],
      password: fields["password"],
      ...(sshKey ? { ssh_keys: [sshKey] } : {}),
      ...(Object.keys(access).length > 0 ? { access_settings: access } : {}),
    }),
  });
  return mapStorageBox(data.storage_box, accountId);
}

/** Edit: rename, resize (`change_type`) and the access toggles. */
export async function updateStorageBox(
  api: HetznerApi,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = trailingId(resourceId);
  const failures: string[] = [];
  const run = async (label: string, path: string, method: string, body: unknown) => {
    try {
      await api.fetchHetzner<unknown>(path, { method, body: JSON.stringify(body) });
    } catch (e) {
      failures.push(`${label} failed: ${errorText(e)}`);
    }
  };
  if (fields["name"]) await run("rename", `/storage_boxes/${id}`, "PUT", { name: fields["name"] });
  if (fields["storageBoxType"]) {
    await run("change type", `/storage_boxes/${id}/actions/change_type`, "POST", {
      storage_box_type: fields["storageBoxType"],
    });
  }
  const access: Record<string, boolean> = {};
  for (const [formKey, apiKey] of ACCESS_KEYS) {
    const v = formBool(fields[formKey]);
    if (v !== undefined) access[apiKey] = v;
  }
  if (Object.keys(access).length > 0) {
    await run(
      "update access settings",
      `/storage_boxes/${id}/actions/update_access_settings`,
      "POST",
      access,
    );
  }
  if (failures.length > 0) throw new Error(`Hetzner Storage Box update: ${failures.join("; ")}`);
  const data = await api.fetchHetzner<{ storage_box: HetznerStorageBox }>(`/storage_boxes/${id}`);
  return mapStorageBox(data.storage_box, accountId);
}

export async function deleteStorageBox(api: HetznerApi, resourceId: string): Promise<void> {
  await api.fetchHetzner<unknown>(`/storage_boxes/${trailingId(resourceId)}`, {
    method: "DELETE",
  });
}

/** Storage Box action ids `invokeAction` accepts. */
export const STORAGE_BOX_ACTIONS = new Set([
  "create_snapshot",
  "enable_protection",
  "disable_protection",
  "disable_snapshot_plan",
]);

export async function invokeStorageBoxAction(
  api: HetznerApi,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = trailingId(resourceId);
  switch (actionId) {
    case "create_snapshot":
      await api.fetchHetzner<unknown>(`/storage_boxes/${id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ description: "Created from Infrawrench" }),
      });
      return;
    case "enable_protection":
    case "disable_protection":
      await api.fetchHetzner<unknown>(`/storage_boxes/${id}/actions/change_protection`, {
        method: "POST",
        body: JSON.stringify({ delete: actionId === "enable_protection" }),
      });
      return;
    case "disable_snapshot_plan":
      await api.fetchHetzner<unknown>(`/storage_boxes/${id}/actions/disable_snapshot_plan`, {
        method: "POST",
      });
      return;
    default:
      throw new Error(`Hetzner plugin: unknown Storage Box action "${actionId}"`);
  }
}
