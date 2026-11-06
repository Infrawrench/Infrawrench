import {
  pathEncode,
  type ApiBody,
  type CreateResourceConfig,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import type { operations } from "./api-types.hetzner.gen.js";
import {
  errorText,
  formBool,
  trailingId,
  type StorageBoxApi,
  type StorageBoxResponse,
} from "./api.js";

/**
 * Storage Boxes, served by the Hetzner API (`api.hetzner.com/v1`, live since
 * 2025-06-25) rather than the Cloud API, but authenticated with the same
 * project API token. Sizes in the API are bytes.
 */

type HetznerStorageBox = StorageBoxResponse<"list_storage_boxes">["storage_boxes"][number];
type AccessKey = keyof ApiBody<operations["update_storage_box_access_settings"]>;
type AccessSettings = Partial<Record<AccessKey, boolean>>;

const BYTES_PER_GB = 1_000_000_000;
const ACCESS_KEYS: Array<[string, AccessKey]> = [
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
  api: StorageBoxApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const boxes = await api.getAll("/storage_boxes", "storage_boxes");
  return boxes.map((b) => mapStorageBox(b, accountId));
}

export async function storageBoxCreateConfig(api: StorageBoxApi): Promise<CreateResourceConfig> {
  const types = await api.getAll("/storage_box_types", "storage_box_types");
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

function accessSettingsFrom(fields: Record<string, string>): AccessSettings {
  const access: AccessSettings = {};
  for (const [formKey, apiKey] of ACCESS_KEYS) {
    const v = formBool(fields[formKey]);
    if (v !== undefined) access[apiKey] = v;
  }
  return access;
}

export async function createStorageBox(
  api: StorageBoxApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const access = accessSettingsFrom(fields);
  const sshKey = fields["sshPublicKey"]?.trim();
  const data = await api.post("/storage_boxes", {
    body: {
      name: fields["name"],
      location: fields["location"],
      storage_box_type: fields["storageBoxType"],
      password: fields["password"],
      ...(sshKey ? { ssh_keys: [sshKey] } : {}),
      ...(Object.keys(access).length > 0 ? { access_settings: access } : {}),
    },
  });
  return mapStorageBox(data.storage_box, accountId);
}

/** Edit: rename, resize (`change_type`) and the access toggles. */
export async function updateStorageBox(
  api: StorageBoxApi,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = pathEncode(trailingId(resourceId));
  const failures: string[] = [];
  const run = async (label: string, request: () => Promise<unknown>) => {
    try {
      await request();
    } catch (e) {
      failures.push(`${label} failed: ${errorText(e)}`);
    }
  };
  const { name, storageBoxType } = fields;
  if (name) await run("rename", () => api.put(`/storage_boxes/${id}`, { body: { name } }));
  if (storageBoxType) {
    await run("change type", () =>
      api.post(`/storage_boxes/${id}/actions/change_type`, {
        body: { storage_box_type: storageBoxType },
      }),
    );
  }
  const access = accessSettingsFrom(fields);
  if (Object.keys(access).length > 0) {
    await run("update access settings", () =>
      api.post(`/storage_boxes/${id}/actions/update_access_settings`, { body: access }),
    );
  }
  if (failures.length > 0) throw new Error(`Hetzner Storage Box update: ${failures.join("; ")}`);
  const data = await api.get(`/storage_boxes/${id}`);
  return mapStorageBox(data.storage_box, accountId);
}

export async function deleteStorageBox(api: StorageBoxApi, resourceId: string): Promise<void> {
  await api.delete(`/storage_boxes/${pathEncode(trailingId(resourceId))}`);
}

/** Storage Box action ids `invokeAction` accepts. */
export const STORAGE_BOX_ACTIONS = new Set([
  "create_snapshot",
  "enable_protection",
  "disable_protection",
  "disable_snapshot_plan",
]);

export async function invokeStorageBoxAction(
  api: StorageBoxApi,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = pathEncode(trailingId(resourceId));
  switch (actionId) {
    case "create_snapshot":
      await api.post(`/storage_boxes/${id}/snapshots`, {
        body: { description: "Created from Infrawrench" },
      });
      return;
    case "enable_protection":
    case "disable_protection":
      await api.post(`/storage_boxes/${id}/actions/change_protection`, {
        body: { delete: actionId === "enable_protection" },
      });
      return;
    case "disable_snapshot_plan":
      await api.post(`/storage_boxes/${id}/actions/disable_snapshot_plan`);
      return;
    default:
      throw new Error(`Hetzner plugin: unknown Storage Box action "${actionId}"`);
  }
}
