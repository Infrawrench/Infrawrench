import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { sshKeys } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { getClientForAccount } from "../../services/plugin-clients";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { sshExec } from "../../services/ssh";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * POST /api/org/:orgId/connect/templates
 * Returns available secret export templates for a source resource type,
 * plus target capabilities (namespaces for K8s, SSH for env deploy).
 */
app.post("/templates", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    sourcePluginId: string;
    sourceResourceTypeId: string;
    targetAccountId: string;
    targetPluginId: string;
  }>();

  // Load source plugin to get templates
  const sourceLoaded = await getPlugin(input.sourcePluginId);
  if (!sourceLoaded) return c.json({ error: "Source plugin not found" }, 404);

  let resourceType = sourceLoaded.plugin.resourceTypes.find(
    (t) => t.id === input.sourceResourceTypeId,
  );
  // For account-level drops, find the first type with templates
  if (
    !resourceType?.secretExportTemplates?.length &&
    input.sourceResourceTypeId === "__account__"
  ) {
    resourceType = sourceLoaded.plugin.resourceTypes.find(
      (t) => (t.secretExportTemplates?.length ?? 0) > 0,
    );
  }

  const templates: SecretExportTemplate[] = resourceType?.secretExportTemplates ?? [];

  // Check if target supports secret import (e.g. Kubernetes)
  const targetLoaded = await getPlugin(input.targetPluginId);
  const supportsSecretImport = targetLoaded?.plugin.manifest.supportsSecretImport ?? false;

  // Load target namespaces if applicable
  let namespaces: string[] = [];
  if (supportsSecretImport) {
    const targetCtx = await getClientForAccount(input.targetAccountId, organizationId);
    if (targetCtx?.client.listNamespacesForImport) {
      try {
        namespaces = await targetCtx.client.listNamespacesForImport("");
      } catch {
        // Namespace listing is best-effort
      }
    }
  }

  return c.json({
    templates,
    effectiveResourceTypeId: resourceType?.id ?? input.sourceResourceTypeId,
    supportsSecretImport,
    namespaces,
  });
});

/**
 * POST /api/org/:orgId/connect/secret-export
 * Creates a secret in the target (e.g. K8s) from the source resource's outputs.
 */
app.post("/secret-export", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    sourceAccountId: string;
    sourceResourceId: string;
    sourcePluginId: string;
    sourceResourceTypeId: string;
    sourceExternalId?: string;
    targetAccountId: string;
    targetPluginId: string;
    templateId: string;
    namespace: string;
    secretName: string;
    keyOverrides: Record<string, string>;
  }>();

  // Load source plugin + client
  const sourceCtx = await getClientForAccount(input.sourceAccountId, organizationId);
  if (!sourceCtx) return c.json({ error: "Source account not found" }, 404);

  const sourceResourceType = sourceCtx.plugin.resourceTypes.find(
    (t) => t.id === input.sourceResourceTypeId,
  );
  let template = sourceResourceType?.secretExportTemplates?.find((t) => t.id === input.templateId);

  // For account-level, search all types
  if (!template && input.sourceResourceTypeId === "__account__") {
    for (const rt of sourceCtx.plugin.resourceTypes) {
      template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
      if (template) break;
    }
  }

  if (!template) return c.json({ error: "Template not found" }, 404);

  // Resolve outputs from source
  const data: Record<string, string> = {};
  for (const entry of template.entries) {
    const envKey = input.keyOverrides[entry.outputKey] ?? entry.envKey;
    try {
      const value = await sourceCtx.client.resolveOutput(
        input.sourceResourceTypeId,
        input.sourceExternalId ?? input.sourceResourceId,
        entry.outputKey,
        input.sourceAccountId,
      );
      data[envKey] = value;
    } catch {
      // Fall through — field-based fallback not available server-side
    }
  }

  if (Object.keys(data).length === 0) {
    return c.json({ error: "Could not resolve any outputs from the source resource" }, 400);
  }

  // Load target plugin + client
  const targetCtx = await getClientForAccount(input.targetAccountId, organizationId);
  if (!targetCtx) return c.json({ error: "Target account not found" }, 404);

  if (!targetCtx.client.importSecret) {
    return c.json({ error: "Target plugin does not support secret import" }, 400);
  }

  await targetCtx.client.importSecret("", {
    namespace: input.namespace,
    secretName: input.secretName,
    data,
  });

  return c.json({ ok: true });
});

/**
 * POST /api/org/:orgId/connect/env-deploy
 * Deploys environment variables from source resource onto target via SSH.
 */
app.post("/env-deploy", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    sourceAccountId: string;
    sourceResourceId: string;
    sourcePluginId: string;
    sourceResourceTypeId: string;
    sourceExternalId?: string;
    targetSshHost: string;
    sshKeyId: string;
    sshUsername: string;
    templateId: string;
    keyOverrides: Record<string, string>;
    format: "dotenv" | "profile";
    filePath: string;
    append: boolean;
  }>();

  // Load source plugin + client
  const sourceCtx = await getClientForAccount(input.sourceAccountId, organizationId);
  if (!sourceCtx) return c.json({ error: "Source account not found" }, 404);

  // Find template
  let template: SecretExportTemplate | undefined;
  for (const rt of sourceCtx.plugin.resourceTypes) {
    template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
    if (template) break;
  }
  if (!template) return c.json({ error: "Template not found" }, 404);

  // Resolve outputs
  const data: Record<string, string> = {};
  for (const entry of template.entries) {
    const envKey = input.keyOverrides[entry.outputKey] ?? entry.envKey;
    try {
      const value = await sourceCtx.client.resolveOutput(
        input.sourceResourceTypeId,
        input.sourceExternalId ?? input.sourceResourceId,
        entry.outputKey,
        input.sourceAccountId,
      );
      data[envKey] = value;
    } catch {
      // skip unresolvable outputs
    }
  }

  if (Object.keys(data).length === 0) {
    return c.json({ error: "Could not resolve any outputs from the source resource" }, 400);
  }

  // Load SSH key
  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, input.sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);
  if (!keyRow) return c.json({ error: "SSH key not found" }, 404);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    return c.json({ error: "SSH key has no private key data" }, 400);
  }
  const privateKey = await decrypt(keyRow.encryptedPrivateKey, keyRow.privateKeyIv);

  // Build env content
  const lines =
    input.format === "profile"
      ? Object.entries(data).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      : Object.entries(data).map(([k, v]) => `${k}=${v}`);
  const content = lines.join("\n") + "\n";

  // Deploy via SSH
  const operator = input.append ? ">>" : ">";
  const escapedContent = content.replace(/'/g, "'\\''");
  await sshExec(
    {
      host: input.targetSshHost,
      port: 22,
      username: input.sshUsername,
      privateKey,
    },
    `printf '%s' '${escapedContent}' ${operator} ${input.filePath}`,
  );

  return c.json({ ok: true });
});

export { app as connectRoutes };
