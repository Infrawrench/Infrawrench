import { ipcMain } from "electron";
import { getAccessToken, forceRefreshAccessToken } from "./cloud-auth";
import { CLOUD_URL } from "../env";
import { promptHostKeyDecision } from "./ssh-host-key-prompt";

interface HostKeyTrustRequiredBody {
  error: "ssh_host_key_trust_required";
  message?: string;
  kind: "unknown" | "mismatch";
  host: string;
  port: number;
  presentedFingerprint: string;
  storedFingerprint?: string | null;
}

function isHostKeyTrustRequired(body: unknown): body is HostKeyTrustRequiredBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    b.error === "ssh_host_key_trust_required" &&
    typeof b.host === "string" &&
    typeof b.port === "number" &&
    typeof b.presentedFingerprint === "string" &&
    (b.kind === "unknown" || b.kind === "mismatch")
  );
}

// On 409 ssh_host_key_trust_required: prompt the user, POST /trust on accept,
// then retry once. `buildInit` is a factory so FormData (a one-shot stream) is
// rebuilt for the retry.
async function fetchWithHostKeyPrompt(
  orgId: string,
  url: string,
  buildInit: () => RequestInit | Promise<RequestInit>,
  token: string,
): Promise<Response> {
  const init = await buildInit();
  const res = await fetch(url, init);
  if (res.status !== 409) return res;

  // Clone first so we can return the original response if this isn't a host-key 409.
  const cloned = res.clone();
  let body: unknown;
  try {
    body = await cloned.json();
  } catch {
    return res;
  }
  if (!isHostKeyTrustRequired(body)) return res;

  const promptKind = body.kind === "unknown" ? "first-connect" : "mismatch";
  const accepted = await promptHostKeyDecision({
    host: body.host,
    port: body.port,
    kind: promptKind,
    presentedFingerprint: body.presentedFingerprint,
    ...(body.storedFingerprint ? { storedFingerprint: body.storedFingerprint } : {}),
  });
  if (!accepted) return res;

  const trustRes = await fetch(
    `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ssh-host-keys/trust`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: body.host,
        port: body.port,
        fingerprint: body.presentedFingerprint,
        ...(body.storedFingerprint ? { previousFingerprint: body.storedFingerprint } : {}),
      }),
    },
  );
  if (!trustRes.ok) {
    // If /trust raced and 409'd again, surface that instead of looping.
    return trustRes;
  }

  const retryInit = await buildInit();
  return fetch(url, retryInit);
}

async function cloudFetch<T>(
  orgId: string,
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  let token = await getAccessToken();
  if (!token) return null;
  const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}${path}`;
  const buildInit = (t: string): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let res = await fetch(url, buildInit(token));
  if (res.status === 401) {
    const refreshed = await forceRefreshAccessToken();
    if (!refreshed) return null;
    token = refreshed;
    res = await fetch(url, buildInit(token));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloud request failed: ${res.status} ${path} ${text}`);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

ipcMain.handle("cloud_list_accounts", async (_e, { orgId }: { orgId: string }) => {
  return (
    (await cloudFetch<
      Array<{ id: string; pluginId: string; displayName: string; createdAt: string }>
    >(orgId, "/accounts")) ?? []
  );
});

ipcMain.handle(
  "cloud_create_account",
  async (
    _e,
    {
      orgId,
      pluginId,
      displayName,
      credentials,
    }: {
      orgId: string;
      pluginId: string;
      displayName: string;
      credentials: Record<string, string>;
    },
  ) => {
    return cloudFetch<{ id: string }>(orgId, "/accounts", {
      method: "POST",
      body: JSON.stringify({ pluginId, displayName, credentials }),
    });
  },
);

ipcMain.handle(
  "cloud_list_account_resources",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    return (
      (await cloudFetch<Array<Record<string, unknown>>>(
        orgId,
        `/accounts/${encodeURIComponent(accountId)}/resources?topLevelOnly=true`,
      )) ?? []
    );
  },
);

ipcMain.handle(
  "cloud_get_account_detail",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    return cloudFetch(orgId, `/accounts/${encodeURIComponent(accountId)}/detail`);
  },
);

ipcMain.handle(
  "cloud_sync_account_type",
  async (
    _e,
    { orgId, accountId, typeId }: { orgId: string; accountId: string; typeId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/accounts/${encodeURIComponent(accountId)}/sync-type/${encodeURIComponent(typeId)}`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
);

ipcMain.handle(
  "cloud_delete_account",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    await cloudFetch(orgId, `/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_rename_account",
  async (
    _e,
    { orgId, accountId, displayName }: { orgId: string; accountId: string; displayName: string },
  ) => {
    return cloudFetch<{ id: string; displayName: string }>(
      orgId,
      `/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      },
    );
  },
);

ipcMain.handle("cloud_list_dashboards", async (_e, { orgId }: { orgId: string }) => {
  return (
    (await cloudFetch<Array<{ id: string; name: string; isDefault: boolean }>>(
      orgId,
      "/dashboards",
    )) ?? []
  );
});

ipcMain.handle(
  "cloud_get_dashboard",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`);
  },
);

ipcMain.handle(
  "cloud_create_dashboard",
  async (_e, { orgId, name }: { orgId: string; name: string }) => {
    return cloudFetch<{ id: string; name: string; isDefault: boolean }>(orgId, "/dashboards", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
);

ipcMain.handle(
  "cloud_delete_dashboard",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_rename_dashboard",
  async (_e, { orgId, id, name }: { orgId: string; id: string; name: string }) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_pin_resource",
  async (
    _e,
    { orgId, dashboardId, resourceId }: { orgId: string; dashboardId: string; resourceId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/pin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, resourceId }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_unpin_resource",
  async (
    _e,
    { orgId, dashboardId, resourceId }: { orgId: string; dashboardId: string; resourceId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/unpin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, resourceId }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_reorder_pins",
  async (
    _e,
    {
      orgId,
      dashboardId,
      resourceIds,
    }: { orgId: string; dashboardId: string; resourceIds: string[] },
  ) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ resourceIds }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_probe_pins",
  async (_e, { orgId, items }: { orgId: string; items: unknown[] }) => {
    return (
      (await cloudFetch<Record<string, unknown>>(orgId, `/dashboards/probe`, {
        method: "POST",
        body: JSON.stringify({ items }),
      })) ?? {}
    );
  },
);

ipcMain.handle("cloud_get_pin", async (_e, { orgId, pinId }: { orgId: string; pinId: string }) => {
  return cloudFetch(orgId, `/dashboards/pin/${encodeURIComponent(pinId)}`);
});

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
    }: {
      orgId: string;
      sources: Array<{ pluginId: string; resourceTypeId: string; outputKey: string }>;
      accountId: string;
    },
  ) => {
    return cloudFetch(orgId, "/resources/picker-resources", {
      method: "POST",
      body: JSON.stringify({ sources, accountId }),
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

ipcMain.handle(
  "cloud_list_secret_versions",
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
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions?${qs}`,
    );
  },
);

ipcMain.handle(
  "cloud_access_secret_version",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/access`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_add_secret_version",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/add`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_modify_secret_version",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/modify`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_fetch_metrics",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/metrics`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_fetch_peer_panes",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/peer-panes`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle("cloud_sql_query", async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
  return cloudFetch(orgId, `/sql/query`, { method: "POST", body: JSON.stringify(body) });
});

ipcMain.handle(
  "cloud_list_artifacts",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/artifacts/list`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_sql_execute",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/sql/execute`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_sql_estimate",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/sql/estimate`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_command",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv/command`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_docker_command",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/docker/command`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle("cloud_sftp_list", async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
  return cloudFetch(orgId, `/sftp/list`, { method: "POST", body: JSON.stringify(body) });
});

ipcMain.handle(
  "cloud_sftp_mkdir",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    await cloudFetch(orgId, `/sftp/mkdir`, { method: "POST", body: JSON.stringify(body) });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_delete",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    await cloudFetch(orgId, `/sftp/delete`, { method: "POST", body: JSON.stringify(body) });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_upload",
  async (
    _e,
    {
      orgId,
      accountId,
      remotePath,
      data,
      filename,
      sshKeyId,
      sshHost,
      sshUsername,
    }: {
      orgId: string;
      accountId: string;
      remotePath: string;
      data: Buffer;
      filename?: string;
      sshKeyId?: string;
      sshHost?: string;
      sshUsername?: string;
    },
  ) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/v1/sftp/upload`;
    const buildInit = (): RequestInit => {
      const form = new FormData();
      form.append("accountId", accountId);
      form.append("remotePath", remotePath);
      form.append(
        "file",
        new Blob([new Uint8Array(data)]),
        filename ?? remotePath.split("/").pop() ?? "upload",
      );
      if (sshKeyId) form.append("sshKeyId", sshKeyId);
      if (sshHost) form.append("sshHost", sshHost);
      if (sshUsername) form.append("sshUsername", sshUsername);
      return {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      };
    };
    const res = await fetchWithHostKeyPrompt(orgId, url, buildInit, token);
    if (!res.ok)
      throw new Error(`Upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_download",
  async (
    _e,
    {
      orgId,
      accountId,
      remotePath,
      localPath,
      sshKeyId,
      sshHost,
      sshUsername,
    }: {
      orgId: string;
      accountId: string;
      remotePath: string;
      localPath: string;
      sshKeyId?: string;
      sshHost?: string;
      sshUsername?: string;
    },
  ) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const params = new URLSearchParams({
      accountId,
      paths: JSON.stringify([remotePath]),
      ...(sshKeyId ? { sshKeyId } : {}),
      ...(sshHost ? { sshHost } : {}),
      ...(sshUsername ? { sshUsername } : {}),
    });
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/v1/sftp/download?${params}`;
    const buildInit = (): RequestInit => ({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await fetchWithHostKeyPrompt(orgId, url, buildInit, token);
    if (!res.ok)
      throw new Error(`Download failed: ${res.status} ${await res.text().catch(() => "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(localPath, buf);
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_connect_templates",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/templates`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_secret_export",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/secret-export`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_env_deploy",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/env-deploy`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_tunnel_create_account",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/ssh-tunnels/create-account`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_tunnel_exec",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/ssh-tunnels/exec`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);
