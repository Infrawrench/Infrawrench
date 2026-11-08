/**
 * Connect: `/api/org/:orgId/connect`, the handlers.
 *
 * Every plugin client call (resolving a source output, listing namespaces,
 * importing a secret) runs inside `legacy`, so the client's egress scope is
 * entered inside the request's scopes.
 */
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { SecretExportTemplate } from "@infrawrench/plugin-base";
import { db } from "../../../db/client";
import { sshKeys } from "../../../db/schema";
import { buildAad, decrypt } from "../../../services/encryption";
import { getPlugin } from "../../../plugins/loader";
import { getClientForAccount } from "../../../services/plugin-clients";
import { sshExec } from "../../../services/ssh";
import { resolveSafeHost } from "../../../services/host-validation";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { hostKeyTrustRefusal } from "../ssh-host-key-trust";
import { ConnectApi, ConnectTemplatesResponse } from "./api";

/**
 * Defense in depth: even with the quote-escape below, banning shell
 * metacharacters guards against shells with non-standard quoting behavior.
 */
const SAFE_FILE_PATH = /^[A-Za-z0-9._/-]+$/;

type SourceClient = NonNullable<Awaited<ReturnType<typeof getClientForAccount>>>;

/** Every template entry the source resolves, keyed by its (possibly overridden) env key. */
const resolveTemplateOutputs = (
  source: SourceClient,
  template: SecretExportTemplate,
  input: {
    readonly sourceAccountId: string;
    readonly sourceResourceId: string;
    readonly sourceResourceTypeId: string;
    readonly sourceExternalId?: string | undefined;
    readonly keyOverrides: { readonly [key: string]: string };
  },
) =>
  legacy(async () => {
    const data: Record<string, string> = {};
    for (const entry of template.entries) {
      const envKey = input.keyOverrides[entry.outputKey] ?? entry.envKey;
      try {
        data[envKey] = await source.client.resolveOutput(
          input.sourceResourceTypeId,
          input.sourceExternalId ?? input.sourceResourceId,
          entry.outputKey,
          input.sourceAccountId,
        );
      } catch {
        // An output the source cannot resolve is left out; field-based
        // fallback is not available server-side.
      }
    }
    return data;
  });

const ConnectHandlers = HttpApiBuilder.group(ConnectApi, "connect", (handlers) =>
  handlers
    /**
     * The secret export templates a source resource type offers, plus what the
     * target can take (namespaces for Kubernetes).
     */
    .handle("templates", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sourceLoaded = yield* legacy(() => getPlugin(input.sourcePluginId));
        if (!sourceLoaded) return yield* notFound("Source plugin not found");

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

        const targetLoaded = yield* legacy(() => getPlugin(input.targetPluginId));
        const supportsSecretImport = targetLoaded?.plugin.manifest.supportsSecretImport ?? false;

        const namespaces = supportsSecretImport
          ? yield* legacy(async (): Promise<string[]> => {
              const targetCtx = await getClientForAccount(input.targetAccountId, organizationId);
              if (!targetCtx?.client.listNamespacesForImport) return [];
              try {
                return await targetCtx.client.listNamespacesForImport("");
              } catch {
                return []; // best-effort
              }
            })
          : [];

        return yield* respond(ConnectTemplatesResponse)({
          templates,
          effectiveResourceTypeId: resourceType?.id ?? input.sourceResourceTypeId,
          supportsSecretImport,
          namespaces,
        });
      }),
    )
    /** Create a secret in the target (e.g. Kubernetes) from the source resource's outputs. */
    .handle("secretExport", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sourceCtx = yield* legacy(() =>
          getClientForAccount(input.sourceAccountId, organizationId),
        );
        if (!sourceCtx) return yield* notFound("Source account not found");

        const sourceResourceType = sourceCtx.plugin.resourceTypes.find(
          (t) => t.id === input.sourceResourceTypeId,
        );
        let template = sourceResourceType?.secretExportTemplates?.find(
          (t) => t.id === input.templateId,
        );
        if (!template && input.sourceResourceTypeId === "__account__") {
          for (const rt of sourceCtx.plugin.resourceTypes) {
            template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
            if (template) break;
          }
        }
        if (!template) return yield* notFound("Template not found");

        const data = yield* resolveTemplateOutputs(sourceCtx, template, input);
        if (Object.keys(data).length === 0) {
          return yield* badRequest("Could not resolve any outputs from the source resource");
        }

        const targetCtx = yield* legacy(() =>
          getClientForAccount(input.targetAccountId, organizationId),
        );
        if (!targetCtx) return yield* notFound("Target account not found");
        const importSecret = targetCtx.client.importSecret;
        if (!importSecret) {
          return yield* badRequest("Target plugin does not support secret import");
        }
        yield* legacy(() =>
          importSecret.call(targetCtx.client, "", {
            namespace: input.namespace,
            secretName: input.secretName,
            data,
          }),
        );
        return ok;
      }),
    )
    /** Write the source resource's outputs as environment variables to a file on an SSH target. */
    .handle("envDeploy", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // SSRF: `targetSshHost` is request body, so this route lets anyone with
        // `resources:execute` pick the destination outright, and here it also
        // decides where the source's secrets get written. Vet it and keep the
        // address: `sshExec` dials what it is given.
        const dialAddress = yield* legacyTry(
          () => resolveSafeHost(input.targetSshHost),
          (error) =>
            new BadRequest({ error: error instanceof Error ? error.message : "Invalid SSH host" }),
        );

        const sourceCtx = yield* legacy(() =>
          getClientForAccount(input.sourceAccountId, organizationId),
        );
        if (!sourceCtx) return yield* notFound("Source account not found");

        let template: SecretExportTemplate | undefined;
        for (const rt of sourceCtx.plugin.resourceTypes) {
          template = rt.secretExportTemplates?.find((t) => t.id === input.templateId);
          if (template) break;
        }
        if (!template) return yield* notFound("Template not found");

        const data = yield* resolveTemplateOutputs(sourceCtx, template, input);
        if (Object.keys(data).length === 0) {
          return yield* badRequest("Could not resolve any outputs from the source resource");
        }

        const filePath = input.filePath;
        if (!SAFE_FILE_PATH.test(filePath)) {
          return yield* badRequest(
            "Invalid filePath: only letters, digits, '.', '_', '/' and '-' are allowed",
          );
        }

        const [keyRow] = yield* legacy(() =>
          db
            .select({
              encryptedPrivateKey: sshKeys.encryptedPrivateKey,
              privateKeyIv: sshKeys.privateKeyIv,
            })
            .from(sshKeys)
            .where(and(eq(sshKeys.id, input.sshKeyId), eq(sshKeys.organizationId, organizationId)))
            .limit(1),
        );
        if (!keyRow) return yield* notFound("SSH key not found");
        const { encryptedPrivateKey, privateKeyIv } = keyRow;
        if (!encryptedPrivateKey || !privateKeyIv) {
          return yield* badRequest("SSH key has no private key data");
        }
        const privateKey = yield* legacy(() =>
          decrypt(
            encryptedPrivateKey,
            privateKeyIv,
            buildAad("sshKey", input.sshKeyId, "privateKey"),
          ),
        );

        const lines =
          input.format === "profile"
            ? Object.entries(data).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
            : Object.entries(data).map(([k, v]) => `${k}=${v}`);
        const content = lines.join("\n") + "\n";

        // Single-quote-escape content and path so nobody can break out of the
        // quoted argument even if file-path validation ever loosens. `operator`
        // is a server-side boolean, no escaping needed.
        const operator = input.append ? ">>" : ">";
        const escapeSingleQuoted = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
        const command = `printf '%s' ${escapeSingleQuoted(content)} ${operator} ${escapeSingleQuoted(filePath)}`;
        yield* legacyTry(
          () =>
            sshExec(
              organizationId,
              {
                // Identity stays the name the operator typed, so the host-key pin
                // is the one they already trust; only the socket goes to `dialAddress`.
                host: input.targetSshHost,
                port: 22,
                username: input.sshUsername,
                privateKey,
              },
              command,
              { dialAddress },
            ),
          hostKeyTrustRefusal,
        );
        return ok;
      }),
    ),
);

export const connectDomain = makeDomain("connect", ConnectApi, ConnectHandlers);
