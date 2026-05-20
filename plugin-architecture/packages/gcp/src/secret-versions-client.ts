import type {
  SecretVersion,
  SecretVersionMutation,
  SecretVersionState,
} from "@infrawrench/plugin-base";
import type { GcpClientContext } from "./shared.js";

function mapSecretVersion(v: Record<string, unknown>): SecretVersion {
  const fullName = String(v["name"] ?? "");
  const id = fullName.split("/").pop() ?? "";
  const rawState = String(v["state"] ?? "ENABLED").toUpperCase();
  const state: SecretVersionState =
    rawState === "DISABLED" ? "disabled" : rawState === "DESTROYED" ? "destroyed" : "enabled";
  const result: SecretVersion = {
    id,
    state,
    createdAt: String(v["createTime"] ?? ""),
  };
  if (v["destroyTime"]) result.destroyedAt = String(v["destroyTime"]);
  return result;
}

function mapKmsKeyVersion(v: Record<string, unknown>, primaryId?: string): SecretVersion {
  const fullName = String(v["name"] ?? "");
  const id = fullName.split("/").pop() ?? "";
  const rawState = String(v["state"] ?? "ENABLED").toUpperCase();
  const state: SecretVersionState =
    rawState === "ENABLED"
      ? "enabled"
      : rawState === "DISABLED" ||
          rawState === "PENDING_GENERATION" ||
          rawState === "PENDING_IMPORT"
        ? "disabled"
        : "destroyed";
  const result: SecretVersion = {
    id,
    state,
    createdAt: String(v["createTime"] ?? ""),
  };
  if (v["destroyTime"] || v["destroyEventTime"]) {
    result.destroyedAt = String(v["destroyTime"] ?? v["destroyEventTime"] ?? "");
  }
  if (primaryId && id === primaryId) result.isLatest = true;
  return result;
}

export async function listSecretVersions(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
): Promise<SecretVersion[]> {
  if (typeId === "kms-key") {
    const resource = await ctx.getResource("kms-key", resourceId, accountId);
    const keyName = resource.externalId ?? "";
    const [versions, key] = await Promise.all([
      ctx.paginate<Record<string, unknown>>(
        `https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`,
        "cryptoKeyVersions",
      ),
      ctx.get<Record<string, unknown>>(`https://cloudkms.googleapis.com/v1/${keyName}`),
    ]);
    const primary = key["primary"] as Record<string, unknown> | undefined;
    const primaryId = String(primary?.["name"] ?? "")
      .split("/")
      .pop();
    return versions.map((v) => mapKmsKeyVersion(v, primaryId));
  }
  const resource = await ctx.getResource("secret-manager-secret", resourceId, accountId);
  const secretName = resource.externalId ?? "";
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://secretmanager.googleapis.com/v1/${secretName}/versions`,
    "versions",
  );
  return items.map((v) => mapSecretVersion(v));
}

export async function accessSecretVersion(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  versionId: string,
): Promise<string> {
  if (typeId === "kms-key") {
    // KMS symmetric key material never leaves Google. Asymmetric public keys
    // are retrievable via gcloud; we don't surface a reveal action in the UI
    // (secretVersions.supportsReveal = false), so this path is only hit by a
    // direct API caller.
    throw new Error("KMS key material cannot be revealed.");
  }
  const resource = await ctx.getResource("secret-manager-secret", resourceId, accountId);
  const secretName = resource.externalId ?? "";
  const data = await ctx.get<Record<string, unknown>>(
    `https://secretmanager.googleapis.com/v1/${secretName}/versions/${encodeURIComponent(versionId)}:access`,
  );
  const payload = data["payload"] as Record<string, unknown> | undefined;
  const b64 = (payload?.["data"] as string) ?? "";
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}

export async function addSecretVersion(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  value: string,
): Promise<SecretVersion> {
  const tok = await ctx.token();
  if (typeId === "kms-key") {
    // KMS generates new material server-side — the `value` argument is ignored.
    const resource = await ctx.getResource("kms-key", resourceId, accountId);
    const keyName = resource.externalId ?? "";
    const res = await fetch(`https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return mapKmsKeyVersion(data);
  }
  const resource = await ctx.getResource("secret-manager-secret", resourceId, accountId);
  const secretName = resource.externalId ?? "";
  const res = await fetch(`https://secretmanager.googleapis.com/v1/${secretName}:addVersion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: { data: btoa(unescape(encodeURIComponent(value))) },
    }),
  });
  if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  return mapSecretVersion(data);
}

export async function modifySecretVersion(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  versionId: string,
  action: SecretVersionMutation,
): Promise<SecretVersion> {
  const tok = await ctx.token();
  if (typeId === "kms-key") {
    const resource = await ctx.getResource("kms-key", resourceId, accountId);
    const keyName = resource.externalId ?? "";
    const versionName = `${keyName}/cryptoKeyVersions/${encodeURIComponent(versionId)}`;
    const url =
      action === "destroy"
        ? `https://cloudkms.googleapis.com/v1/${versionName}:destroy`
        : `https://cloudkms.googleapis.com/v1/${versionName}?updateMask=state`;
    const body =
      action === "destroy"
        ? "{}"
        : JSON.stringify({ state: action === "enable" ? "ENABLED" : "DISABLED" });
    const res = await fetch(url, {
      method: action === "destroy" ? "POST" : "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return mapKmsKeyVersion(data);
  }
  const resource = await ctx.getResource("secret-manager-secret", resourceId, accountId);
  const secretName = resource.externalId ?? "";
  const verb = action === "enable" ? "enable" : action === "disable" ? "disable" : "destroy";
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/${secretName}/versions/${encodeURIComponent(versionId)}:${verb}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  return mapSecretVersion(data);
}
