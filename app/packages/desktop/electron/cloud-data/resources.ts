import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle(
  "cloud_get_resource_detail",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
      includePeerPanes,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
      includePeerPanes?: boolean;
    },
  ) => {
    const params: Record<string, string> = { resourceId, accountId };
    if (parentResourceId) params["parentResourceId"] = parentResourceId;
    if (includePeerPanes === false) params["includePeerPanes"] = "false";
    const qs = new URLSearchParams(params).toString();
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/detail?${qs}`,
    );
  },
);

ipcMain.handle(
  "cloud_create_resource",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/resources/create`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_get_create_config",
  async (
    _e,
    {
      orgId,
      accountId,
      resourceTypeId,
      pluginId,
      parentResourceId,
    }: {
      orgId: string;
      accountId: string;
      resourceTypeId: string;
      pluginId?: string;
      parentResourceId?: string;
    },
  ) => {
    return cloudFetch(orgId, `/resources/create-config`, {
      method: "POST",
      body: JSON.stringify({
        accountId,
        resourceTypeId,
        ...(pluginId ? { pluginId } : {}),
        ...(parentResourceId ? { parentResourceId } : {}),
      }),
    });
  },
);

ipcMain.handle(
  "cloud_load_picker_resources",
  async (
    _e,
    {
      orgId,
      sources,
      accountId,
      regionHint,
    }: {
      orgId: string;
      sources: Array<{ pluginId: string; resourceTypeId: string; outputKey: string }>;
      accountId: string;
      regionHint?: string;
    },
  ) => {
    return cloudFetch(orgId, "/resources/picker-resources", {
      method: "POST",
      body: JSON.stringify({ sources, accountId, ...(regionHint ? { regionHint } : {}) }),
    });
  },
);

ipcMain.handle(
  "cloud_get_create_pricing",
  async (
    _e,
    {
      orgId,
      accountId,
      resourceTypeId,
      regionId,
      sizes,
      pluginId,
      parentResourceId,
    }: {
      orgId: string;
      accountId: string;
      resourceTypeId: string;
      regionId?: string;
      sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
      pluginId?: string;
      parentResourceId?: string;
    },
  ) => {
    return cloudFetch(orgId, `/resources/create-pricing`, {
      method: "POST",
      body: JSON.stringify({
        accountId,
        resourceTypeId,
        ...(regionId ? { regionId } : {}),
        sizes,
        ...(pluginId ? { pluginId } : {}),
        ...(parentResourceId ? { parentResourceId } : {}),
      }),
    });
  },
);

ipcMain.handle(
  "cloud_get_create_cost_estimate",
  async (
    _e,
    {
      orgId,
      accountId,
      resourceTypeId,
      fields,
      pluginId,
      parentResourceId,
    }: {
      orgId: string;
      accountId: string;
      resourceTypeId: string;
      fields: Record<string, string>;
      pluginId?: string;
      parentResourceId?: string;
    },
  ) => {
    return cloudFetch<{ estimate: unknown }>(orgId, `/resources/create-cost-estimate`, {
      method: "POST",
      body: JSON.stringify({
        accountId,
        resourceTypeId,
        fields,
        ...(pluginId ? { pluginId } : {}),
        ...(parentResourceId ? { parentResourceId } : {}),
      }),
    });
  },
);

ipcMain.handle(
  "cloud_delete_resource",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
    },
  ) => {
    const params: Record<string, string> = { resourceId, accountId };
    if (parentResourceId) params["parentResourceId"] = parentResourceId;
    const qs = new URLSearchParams(params).toString();
    await cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}?${qs}`,
      { method: "DELETE" },
    );
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_export_credential",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      formatId,
      parentResourceId,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      formatId: string;
      parentResourceId?: string;
    },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/export-credential`,
      {
        method: "POST",
        body: JSON.stringify({
          resourceId,
          accountId,
          formatId,
          ...(parentResourceId ? { parentResourceId } : {}),
        }),
      },
    );
  },
);

ipcMain.handle(
  "cloud_get_manifest",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
    },
  ) => {
    const params: Record<string, string> = { resourceId, accountId };
    if (parentResourceId) params["parentResourceId"] = parentResourceId;
    const qs = new URLSearchParams(params).toString();
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/manifest?${qs}`,
    );
  },
);

ipcMain.handle(
  "cloud_apply_manifest",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    await cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/manifest`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_invoke_action",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    await cloudFetch(orgId, `/resources/invoke-action`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_nosql_command",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    const res = await cloudFetch(orgId, `/resources/nosql-command`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res as { result?: unknown };
  },
);

ipcMain.handle(
  "cloud_import_yaml",
  async (_e, { orgId, pluginId, body }: { orgId: string; pluginId: string; body: unknown }) => {
    return cloudFetch(orgId, `/resources/${encodeURIComponent(pluginId)}/import-yaml`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_describe_resource",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
    },
  ) => {
    return cloudFetch<{ text: string }>(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/describe`,
      {
        method: "POST",
        body: JSON.stringify({
          accountId,
          resourceId,
          ...(parentResourceId ? { parentResourceId } : {}),
        }),
      },
    );
  },
);

ipcMain.handle(
  "cloud_get_logs",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
      tailLines,
      container,
      previous,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
      tailLines?: number;
      container?: string;
      previous?: boolean;
    },
  ) => {
    return cloudFetch<{
      text: string;
      containers: string[];
      activeContainer: string;
    }>(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/logs`,
      {
        method: "POST",
        body: JSON.stringify({
          accountId,
          resourceId,
          ...(parentResourceId ? { parentResourceId } : {}),
          ...(tailLines !== undefined ? { tailLines } : {}),
          ...(container !== undefined ? { container } : {}),
          ...(previous !== undefined ? { previous } : {}),
        }),
      },
    );
  },
);
