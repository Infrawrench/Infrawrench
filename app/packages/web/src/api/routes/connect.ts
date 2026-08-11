import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { sshKeys } from "../../db/schema";
import { decrypt, buildAad } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { getClientForAccount } from "../../services/plugin-clients";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { sshExec } from "../../services/ssh";
import { resolveSafeHost } from "../../services/host-validation";
import { HostKeyTrustRequiredError } from "../../services/ssh-host-keys";
import { hostKeyTrustResponse } from "./ssh-host-keys";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

// Defense in depth: even with the quote-escape below, banning shell
// metacharacters guards against shells with non-standard quoting behavior.
const envDeployFilePathSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/);

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

  const sourceLoaded = await getPlugin(input.sourcePluginId);
  if (!sourceLoaded) return c.json({ error: "Source plugin not found" }, 404);

  let resourceType = sourceLoaded.plugin.resourceTypes.find(
    (t) => t.id === input.sourceResourceTypeId,
  );
  // Account-level drops: pick the first type that has templates.
  if (
    !resourceType?.secretExportTemplates?.length &&
    input.sourceResourceTypeId === "__account__"
  ) {
    resourceType = sourceLoaded.plugin.resourceTypes.find(
      (t) => (t.secretExportTemplates?.length ?? 0) > 0,
    );
  }

  const templates: SecretExportTemplate[] = resourceType?.secretExportTemplates ?? [];

  const targetLoaded = await getPlugin(input.targetPluginId);
  const supportsSecretImport = targetLoaded?.plugin.manifest.supportsSecretImport ?? false;

  let namespaces: string[] = [];
  if (supportsSecretImport) {
    const targetCtx = await getClientForAccount(input.targetAccountId, organizationId);
    if (targetCtx?.client.listNamespacesForImport) {
      try {
        namespaces = await targetCtx.client.listNamespacesForImport("");
      } catch {
        // best-effort
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

  const sourceCtx = await getClientForAccount(input.sourceAccountId, organizationId);
  if (!sourceCtx) return c.json({ error: "Source account not found" }, 404);

  const sourceResourceType = sourceCtx.plugin.resourceTypes.find(
    (t) => t.id === input.sourceResourceTypeId,
  );
  let template = sourceResourceType?.secretExportTemplates?.find((t) => t.id === input.templateId);

  if (!template && input.sourceResourceTypeId === "__account__") {
    for (const rt of sourceCtx.plugin.resourceTypes) {
      template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
      if (template) break;
    }
  }

  if (!template) return c.json({ error: "Template not found" }, 404);

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
      // field-based fallback isn't available server-side
    }
  }

  if (Object.keys(data).length === 0) {
    return c.json({ error: "Could not resolve any outputs from the source resource" }, 400);
  }

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

  // SSRF: `targetSshHost` is request body, so this route lets anyone with
  // `resources:execute` pick the destination outright — the same exposure the
  // SSH terminal frame has, and here it also decides where the source
  // resource's secrets get written. Vet it and keep the address: `sshExec`
  // dials what it is given, so nothing downstream re-resolves for us.
  let dialAddress: string;
  try {
    dialAddress = await resolveSafeHost(input.targetSshHost);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid SSH host" }, 400);
  }

  const sourceCtx = await getClientForAccount(input.sourceAccountId, organizationId);
  if (!sourceCtx) return c.json({ error: "Source account not found" }, 404);

  let template: SecretExportTemplate | undefined;
  for (const rt of sourceCtx.plugin.resourceTypes) {
    template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
    if (template) break;
  }
  if (!template) return c.json({ error: "Template not found" }, 404);

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

  const parsedFilePath = envDeployFilePathSchema.safeParse(input.filePath);
  if (!parsedFilePath.success) {
    return c.json(
      {
        error: "Invalid filePath: only letters, digits, '.', '_', '/' and '-' are allowed",
      },
      400,
    );
  }
  const safeFilePath = parsedFilePath.data;

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
  const privateKey = await decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", input.sshKeyId, "privateKey"),
  );

  const lines =
    input.format === "profile"
      ? Object.entries(data).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      : Object.entries(data).map(([k, v]) => `${k}=${v}`);
  const content = lines.join("\n") + "\n";

  // Single-quote-escape content + path so an attacker can't break out of the
  // quoted argument even if file-path validation ever loosens. `operator` is
  // server-side boolean, no escaping needed.
  const operator = input.append ? ">>" : ">";
  const escapeSingleQuoted = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const quotedContent = escapeSingleQuoted(content);
  const quotedFilePath = escapeSingleQuoted(safeFilePath);
  try {
    await sshExec(
      organizationId,
      {
        // Identity stays the name the operator typed, so the host-key pin is
        // the one they already trust; only the socket goes to `dialAddress`.
        host: input.targetSshHost,
        port: 22,
        username: input.sshUsername,
        privateKey,
      },
      `printf '%s' ${quotedContent} ${operator} ${quotedFilePath}`,
      { dialAddress },
    );
  } catch (err) {
    if (err instanceof HostKeyTrustRequiredError) {
      return hostKeyTrustResponse(c, err);
    }
    throw err;
  }

  return c.json({ ok: true });
});

export { app as connectRoutes };
