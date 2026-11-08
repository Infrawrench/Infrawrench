/**
 * Accounts: `/api/org/:orgId/accounts`, the handlers.
 *
 * Plugins are reached only from promise code inside `legacy`: building a
 * client, wrapping it in its egress scope and calling it all happen in one
 * function, so the SSRF guard's AsyncLocalStorage scope is entered on the
 * call itself and no client is ever held by Effect code.
 *
 * Bodies are read raw (`handleRaw`) and decoded against the shapes the Hono
 * handlers declared, which are looser than the documented requests: an empty
 * `displayName` or a missing `credentials` on create was always accepted.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { refreshAllowlistById } from "@infrawrench/server-core/bastion/registry";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { buildPluginHostServices } from "@infrawrench/server-core/host-services";
import { runInEgressScope, withEgressScope } from "@infrawrench/server-core/egress-guard";
import { runAccountPreflight } from "@infrawrench/server-core/preflight";
import {
  OAuthCredentialError,
  OAuthReconnectRequiredError,
  acceptSubmittedCredentials,
  pluginOAuthSummary,
  postgresCredentialStore,
  redactOAuthGrantState,
  resolveCredentialUpdate,
  resolveOAuthCredentials,
  type AcceptedCredentials,
  type OAuthStatus,
} from "@infrawrench/server-core/provider-oauth";
import { showcaseFields, stripOAuthGrantState } from "@infrawrench/plugin-base";
import { db } from "../../../db/client";
import { accounts, bastionVms, resources } from "../../../db/schema";
import { buildAad, decrypt, encrypt } from "../../../services/encryption";
import { getPlugin, loadPlugins } from "../../../plugins/loader";
import { getClientForAccount } from "../../../services/plugin-clients";
import { syncAccountResources, syncAccountResourceType } from "../../../services/sync-resources";
import { exportStoredResourcesToTerraform } from "../../../services/terraform-export";
import { FREE_PLAN_LIMITS, planAccess } from "../../../services/entitlements";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, HttpFailure, notFound, PaymentRequired } from "../../errors";
import { decodeAsPayload, fieldsOf, readJson } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { TerraformExport } from "../../schemas/terraform-export";
import {
  AccountDetail,
  AccountsApi,
  Account,
  CreateAccountResponse,
  CredentialOptionsResponse,
  PluginSummary,
  PolicyTemplateResponse,
  PreflightReport,
  Resource,
  RotatedCredentials,
  SyncedResource,
  SyncResponse,
  UpdatedAccount,
} from "./api";

const StringMap = Schema.Record(Schema.String, Schema.String);
/** A credentials map as sent back, without inspecting a value (see `credentials`). */
const CredentialsMap = Schema.Record(Schema.String, Schema.Unknown);
const OptionalId = Schema.optionalKey(Schema.NullOr(Schema.String));

/** What each handler's `c.req.json<...>()` declared, the shape it went on to use. */
const PreflightBody = Schema.Struct({
  pluginId: Schema.String,
  credentials: StringMap,
  bastionId: OptionalId,
});
const CredentialOptionsBody = Schema.Struct({
  pluginId: Schema.String,
  fieldKey: Schema.String,
  credentials: StringMap,
  bastionId: OptionalId,
  accountId: OptionalId,
});
const CreateBody = Schema.Struct({
  pluginId: Schema.String,
  displayName: Schema.String,
  credentials: Schema.optionalKey(Schema.NullOr(StringMap)),
  bastionId: OptionalId,
});
const UpdateBody = Schema.Struct({
  displayName: Schema.optionalKey(Schema.Unknown),
  bastionId: OptionalId,
});

/** A thrown value's message, as the routes' `catch` blocks answered it. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const oauthRefusal = (error: unknown) =>
  error instanceof OAuthCredentialError ? badRequest(error.message) : undefined;

/**
 * The plugin's verdict on whether `credentials` may be used on this shared
 * server (a kubeconfig that runs a local command may not, for instance).
 * Checked where credentials enter, so the user sees the reason up front;
 * the plugin's server-side code refuses them again at use time.
 */
async function serverCredentialError(
  pluginId: string,
  credentials: Record<string, string>,
): Promise<string | null> {
  const loaded = await getPlugin(pluginId);
  return loaded?.plugin.validateServerCredentials?.(credentials) ?? null;
}

/**
 * Open submitted credentials that may carry a sealed provider OAuth grant
 * (`__oauth`, from the Connect flow) into what the server stores and hands to
 * the plugin. A grant that is unusable (expired, minted for another org, user
 * or plugin, or not a sealed grant at all) is a 400.
 */
const openSubmittedCredentials = (
  pluginId: string,
  credentials: Record<string, string>,
  organizationId: string,
  userId: string,
) =>
  legacyTry(async (): Promise<AcceptedCredentials> => {
    const loaded = await getPlugin(pluginId);
    if (!loaded) return { credentials, oauthStatus: null };
    return acceptSubmittedCredentials(credentials, {
      manifest: loaded.plugin.manifest,
      organizationId,
      userId,
    });
  }, oauthRefusal);

/** Fail with the route's 400 when the plugin refuses the credentials on this server. */
const refuseServerCredentials = Effect.fnUntraced(function* (
  pluginId: string,
  credentials: Record<string, string>,
) {
  const error = yield* legacy(() => serverCredentialError(pluginId, credentials));
  if (error) return yield* badRequest(error);
});

/** The bastion id if it belongs to this org; never trust the client. */
const orgBastion = (organizationId: string, bastionId: string) =>
  legacy(() =>
    db
      .select({ id: bastionVms.id })
      .from(bastionVms)
      .where(and(eq(bastionVms.id, bastionId), eq(bastionVms.organizationId, organizationId)))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]?.id));

/** A bastion the body names, `null` for none, or the route's 400 when it is not this org's. */
const validatedBastion = Effect.fnUntraced(function* (
  organizationId: string,
  bastionId: string | null | undefined,
) {
  if (!bastionId) return null;
  const id = yield* orgBastion(organizationId, bastionId);
  if (!id) return yield* badRequest("Bastion not found");
  return id;
});

/** Log a failed allowlist push, as every caller of it here always has. */
const refreshAllowlist = (bastionId: string) =>
  refreshAllowlistById(bastionId).catch((err: unknown) => {
    console.error(`[accounts] refreshAllowlistById(${bastionId}) failed:`, err);
  });

/** Tell a bastion's agent that what one of its accounts may reach has changed. */
const refreshBastionAfterAccountChange = (bastionId: string | null | undefined) =>
  bastionId ? fireAndForget(() => keepAlive(refreshAllowlist(bastionId))) : Effect.void;

const resourceColumns = {
  id: resources.id,
  pluginId: resources.pluginId,
  resourceTypeId: resources.resourceTypeId,
  accountId: resources.accountId,
  displayName: resources.displayName,
  externalId: resources.externalId,
  fieldsJson: resources.fieldsJson,
  outputsJson: resources.outputsJson,
  parentResourceId: resources.parentResourceId,
};

/**
 * The `topLevelOnly` filter. Top-level resources have no parent. Child types
 * can opt into the sidebar via `showInSidebar` on their
 * `ResourceTypeDefinition`; those resource type ids are included alongside
 * the parentless rows.
 *
 * An account-root type is the exception in both directions: it *is* the
 * account, so it is excluded and its direct children are promoted into the
 * top level it vacated. This has to mirror `getListableResourceTypes` in
 * `@infrawrench/ui`: desktop reads the plugin registry directly and uses that
 * helper, so any disagreement here shows up as the two apps expanding the
 * same account to different things.
 */
async function topLevelConditions(): Promise<SQL[]> {
  const conditions: SQL[] = [];
  const sidebarChildTypeIds = new Set<string>();
  const excludedTypeIds = new Set<string>();
  for (const p of await loadPlugins()) {
    const root = p.plugin.resourceTypes.find((t) => t.accountRoot && !t.parentTypeId);
    if (root) excludedTypeIds.add(root.id);
    for (const t of p.plugin.resourceTypes) {
      if (t.parentTypeId && (t.showInSidebar || (root && t.parentTypeId === root.id))) {
        sidebarChildTypeIds.add(t.id);
      }
    }
  }
  if (sidebarChildTypeIds.size === 0) {
    conditions.push(isNull(resources.parentResourceId));
  } else {
    const sidebarChildClause = inArray(resources.resourceTypeId, [...sidebarChildTypeIds]);
    const orExpr = or(isNull(resources.parentResourceId), sidebarChildClause);
    if (orExpr) conditions.push(orExpr);
  }
  if (excludedTypeIds.size > 0) {
    conditions.push(notInArray(resources.resourceTypeId, [...excludedTypeIds]));
  }
  return conditions;
}

/** The decrypted credentials, refreshed when an OAuth token is about to expire. */
async function readableCredentials(row: {
  readonly id: string;
  readonly pluginId: string;
  readonly oauthStatus: string | null;
  readonly encryptedCredentials: string;
  readonly credentialsIv: string;
  readonly organizationId: string;
}): Promise<Record<string, string>> {
  // Refresh an expiring OAuth token first, so a caller (the desktop in cloud
  // mode) always receives one that works, then redact the grant state: the
  // refresh token never leaves the server, but plugins that branch on the
  // grant still find it. A dead grant (`reconnect_required`) is not an error
  // here; the stored credentials come back so the reconnect flow can run.
  const stored: Record<string, string> = JSON.parse(
    await decrypt(
      row.encryptedCredentials,
      row.credentialsIv,
      buildAad("account", row.id, "credentials"),
    ),
  );
  let current = stored;
  const loaded = await getPlugin(row.pluginId);
  if (loaded && row.oauthStatus !== "reconnect_required") {
    try {
      current = await resolveOAuthCredentials({
        accountId: row.id,
        organizationId: row.organizationId,
        manifest: loaded.plugin.manifest,
        credentials: stored,
      });
    } catch (e) {
      if (!(e instanceof OAuthReconnectRequiredError)) throw e;
    }
  }
  return redactOAuthGrantState(current);
}

/** A stored account's preflight, or why there is none. */
type StoredPreflight =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "missing" }
  | { readonly kind: "report"; readonly report: Awaited<ReturnType<typeof runAccountPreflight>> };

/** Why `sync-type` failed, as the route answered it: missing things 404, the rest 500. */
const syncTypeFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : "Sync failed";
  return new HttpFailure(message.includes("not found") ? 404 : 500, { error: message });
};

const AccountsHandlers = HttpApiBuilder.group(AccountsApi, "accounts", (handlers) =>
  handlers
    .handle("plugins", () =>
      Effect.gen(function* () {
        const plugins = yield* legacy(() => loadPlugins());
        return yield* respond(Schema.Array(PluginSummary))(
          plugins.map((p) => ({
            id: p.plugin.manifest.id,
            displayName: p.plugin.manifest.displayName,
            logoSvg: p.plugin.manifest.logoSvg,
            credentialFields: p.plugin.manifest.credentialFields.map((f) => ({
              key: f.key,
              label: f.label,
              description: f.description,
              placeholder: f.placeholder,
              sensitive: f.sensitive,
              multiline: f.multiline,
              defaultValue: f.defaultValue,
              regions: f.regions,
              optional: f.optional,
              advanced: f.advanced,
              accountReference: f.accountReference,
              providerOptions: f.providerOptions,
              helpLink: f.helpLink,
            })),
            preflight: p.plugin.manifest.preflight ?? null,
            sshTunnel: p.plugin.manifest.sshTunnel,
            jumpHost: p.plugin.manifest.jumpHost,
            kvBrowser: p.plugin.manifest.kvDriver?.browser,
            // Present only when this server can run the plugin's OAuth flow.
            ...(() => {
              const oauth = pluginOAuthSummary(p.plugin.manifest);
              return oauth ? { oauth } : {};
            })(),
          })),
        );
      }),
    )
    .handle("policyTemplate", ({ params, query }) =>
      Effect.gen(function* () {
        const loaded = yield* legacy(() => getPlugin(params.pluginId));
        if (!loaded) return yield* notFound("Plugin not found");
        const declaration = loaded.plugin.manifest.preflight;
        const policyTemplate = loaded.plugin.policyTemplate;
        if (!declaration?.templateFormat || !policyTemplate) {
          return yield* badRequest("Plugin does not provide a policy template");
        }
        const declaredIds = declaration.capabilities.map((cap) => cap.id);
        const requested = (query.capabilities ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        // A typo'd capability id must not silently widen the template to
        // everything: that's the opposite of least privilege.
        const declaredIdSet = new Set(declaredIds);
        const unknown = requested.filter((s) => !declaredIdSet.has(s));
        if (unknown.length > 0) {
          return yield* badRequest(`Unknown capability ids: ${unknown.join(", ")}`);
        }
        const capabilityIds = requested.length > 0 ? Array.from(new Set(requested)) : declaredIds;
        const template = yield* legacy(async () =>
          policyTemplate.call(loaded.plugin, capabilityIds),
        );
        return yield* respond(PolicyTemplateResponse)({ template });
      }),
    )
    // The credentials are used for the probe only; nothing is stored.
    .handleRaw("preflight", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(
          PreflightBody,
          yield* fieldsOf(yield* readJson(request)),
        );
        const loaded = yield* legacy(() => getPlugin(body.pluginId));
        if (!loaded) return yield* notFound("Plugin not found");
        const opened = yield* openSubmittedCredentials(
          body.pluginId,
          body.credentials,
          organizationId,
          session.userId,
        );
        const credentials = opened.credentials;
        yield* refuseServerCredentials(body.pluginId, credentials);
        // Same never-trust-the-client check as account creation, so the probe
        // egresses through the same path the account will.
        const bastionId = yield* validatedBastion(organizationId, body.bastionId);
        const report = yield* legacyTry(
          async () => {
            const hostServices = await buildPluginHostServices(
              loaded.plugin.manifest,
              credentials,
              { organizationId, bastionId },
            );
            const client = withEgressScope(loaded.plugin.createClient(credentials, hostServices), {
              organizationId,
            });
            return runAccountPreflight(loaded.plugin, client);
          },
          // createClient throws on malformed credentials (bad JSON key, missing
          // field): that's a user-fixable state, not a 500.
          (e) => badRequest(messageOf(e)),
        );
        return yield* respond(PreflightReport)(report);
      }),
    )
    // Egress follows the bastion picked in the form or, when editing an
    // existing account (`accountId`), that account's own binding.
    .handleRaw("credentialOptions", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(
          CredentialOptionsBody,
          yield* fieldsOf(yield* readJson(request)),
        );
        const loaded = yield* legacy(() => getPlugin(body.pluginId));
        if (!loaded) return yield* notFound("Plugin not found");
        const plugin = loaded.plugin;
        const field = plugin.manifest.credentialFields.find((f) => f.key === body.fieldKey);
        const listCredentialOptions = plugin.listCredentialOptions;
        if (!field?.providerOptions || !listCredentialOptions) {
          return yield* badRequest("This field has no provider options");
        }
        const opened = yield* openSubmittedCredentials(
          body.pluginId,
          body.credentials,
          organizationId,
          session.userId,
        );
        const credentials = opened.credentials;
        yield* refuseServerCredentials(body.pluginId, credentials);

        let bastionId: string | null = null;
        if (body.accountId) {
          const accountId = body.accountId;
          const [account] = yield* legacy(() =>
            db
              .select({ bastionId: accounts.bastionId, pluginId: accounts.pluginId })
              .from(accounts)
              .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
              .limit(1),
          );
          if (!account || account.pluginId !== body.pluginId) {
            return yield* notFound("Account not found");
          }
          bastionId = account.bastionId;
        } else {
          bastionId = yield* validatedBastion(organizationId, body.bastionId);
        }

        const options = yield* legacyTry(
          async () => {
            const hostServices = await buildPluginHostServices(plugin.manifest, credentials, {
              organizationId,
              bastionId,
            });
            const list = listCredentialOptions.bind(plugin);
            // Same egress scope a client gets, so a plugin calling the global
            // fetch still reaches the guarded dispatcher.
            return runInEgressScope({ organizationId }, () =>
              list(body.fieldKey, credentials, hostServices),
            );
          },
          // The plugin throws user-facing messages (wrong key, wrong region);
          // the form shows them and falls back to a text input.
          (e) => badRequest(messageOf(e)),
        );
        return yield* respond(CredentialOptionsResponse)({ options });
      }),
    )
    .handle("storedPreflight", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        // The account's client is built and used in one promise call, inside
        // its egress scope.
        const outcome = yield* legacy(async (): Promise<StoredPreflight> => {
          let ctx;
          try {
            ctx = await getClientForAccount(params.id, organizationId);
          } catch (e) {
            return { kind: "invalid", message: messageOf(e) };
          }
          if (!ctx) return { kind: "missing" };
          return { kind: "report", report: await runAccountPreflight(ctx.plugin, ctx.client) };
        });
        if (outcome.kind === "invalid") return yield* badRequest(outcome.message);
        if (outcome.kind === "missing") return yield* notFound("Account or plugin not found");
        return yield* respond(PreflightReport)(outcome.report);
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select({
              id: accounts.id,
              pluginId: accounts.pluginId,
              displayName: accounts.displayName,
              bastionId: accounts.bastionId,
              oauthStatus: accounts.oauthStatus,
              createdAt: accounts.createdAt,
            })
            .from(accounts)
            .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
        );
        return yield* respond(Schema.Array(Account))(rows);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(CreateBody, yield* fieldsOf(yield* readJson(request)));
        const { pluginId, displayName } = body;

        // A sealed OAuth grant from the Connect flow becomes the real grant
        // state here; anything else in `__oauth` is refused.
        const { credentials, oauthStatus } = yield* openSubmittedCredentials(
          pluginId,
          body.credentials ?? {},
          organizationId,
          session.userId,
        );
        yield* refuseServerCredentials(pluginId, credentials);

        // The free plan caps connected accounts. Deleted accounts don't count:
        // the filter matches the list route's.
        const access = yield* legacy(() => planAccess(organizationId));
        if (!access.paid) {
          const [row] = yield* legacy(() =>
            db
              .select({ n: sql<number>`count(*)` })
              .from(accounts)
              .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
          );
          if (Number(row?.n ?? 0) >= FREE_PLAN_LIMITS.accounts) {
            return yield* new PaymentRequired({
              error: `The free plan includes ${FREE_PLAN_LIMITS.accounts} connected accounts. Upgrade to Pro to add more.`,
            });
          }
        }

        const bastionId = yield* validatedBastion(organizationId, body.bastionId);

        const id = uuid();
        yield* legacy(async () => {
          const { ciphertext, iv } = await encrypt(
            JSON.stringify(credentials),
            buildAad("account", id, "credentials"),
          );
          await db.insert(accounts).values({
            id,
            organizationId,
            pluginId,
            displayName,
            encryptedCredentials: ciphertext,
            credentialsIv: iv,
            bastionId,
            oauthStatus,
          });
        });

        // If the new account is bound to a bastion that's currently connected,
        // push the refreshed destination allowlist so the agent immediately
        // starts accepting traffic to this plugin's cloud APIs.
        if (bastionId) yield* fireAndForget(() => refreshAllowlist(bastionId));

        // Sync resources before returning so the UI has data immediately. If
        // the sync itself blows up we still return the freshly-created account
        // row, but we surface the failure to the caller so they can render a
        // warning.
        const syncError = yield* legacy(async () => {
          try {
            await syncAccountResources(id, organizationId);
            return undefined;
          } catch (e) {
            console.error(`[createAccount] Sync failed for ${id}:`, e);
            return { message: messageOf(e) };
          }
        });

        return yield* respond(CreateAccountResponse)({ id, syncError });
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() =>
          db
            .delete(accounts)
            .where(and(eq(accounts.id, params.id), eq(accounts.organizationId, organizationId)))
            .returning({ bastionId: accounts.bastionId }),
        );
        // Its plugin's hosts and the host it configured stop being reachable with it.
        yield* refreshBastionAfterAccountChange(deleted[0]?.bastionId);
        return ok;
      }),
    )
    // Rename an account or change its bastion binding.
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(UpdateBody, yield* fieldsOf(yield* readJson(request)));
        const accountId = params.id;

        const updates: { displayName?: string; bastionId?: string | null } = {};
        if (body.displayName !== undefined) {
          if (typeof body.displayName !== "string" || !body.displayName.trim()) {
            return yield* badRequest("displayName is required");
          }
          updates.displayName = body.displayName;
        }
        let oldBastionId: string | null = null;
        if (body.bastionId !== undefined) {
          if (body.bastionId === null) {
            updates.bastionId = null;
          } else {
            const bastionId = yield* orgBastion(organizationId, body.bastionId);
            if (!bastionId) return yield* badRequest("Bastion not found");
            updates.bastionId = bastionId;
          }
          // Look up the previous bastionId so we can refresh both allowlists.
          const [existing] = yield* legacy(() =>
            db
              .select({ bastionId: accounts.bastionId })
              .from(accounts)
              .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
              .limit(1),
          );
          oldBastionId = existing?.bastionId ?? null;
        }
        if (Object.keys(updates).length === 0) return yield* badRequest("Nothing to update");

        const [updated] = yield* legacy(() =>
          db
            .update(accounts)
            .set(updates)
            .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
            .returning({
              id: accounts.id,
              displayName: accounts.displayName,
              bastionId: accounts.bastionId,
            }),
        );
        if (!updated) return yield* notFound("Account not found");
        if (body.bastionId !== undefined) {
          if (oldBastionId && oldBastionId !== updates.bastionId) {
            const previous = oldBastionId;
            yield* fireAndForget(() => refreshAllowlist(previous));
          }
          if (updates.bastionId) {
            const next = updates.bastionId;
            yield* fireAndForget(() => refreshAllowlist(next));
          }
        }
        return yield* respond(UpdatedAccount)(updated);
      }),
    )
    .handle("credentials", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const accountId = params.id;
        const [row] = yield* legacy(() =>
          db
            .select({
              id: accounts.id,
              organizationId: accounts.organizationId,
              pluginId: accounts.pluginId,
              oauthStatus: accounts.oauthStatus,
              encryptedCredentials: accounts.encryptedCredentials,
              credentialsIv: accounts.credentialsIv,
            })
            .from(accounts)
            .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId))),
        );
        if (!row) return yield* notFound("Account not found");
        const credentials = yield* legacy(() =>
          readableCredentials({ ...row, id: accountId, organizationId }),
        );
        // This is the only route that hands a provider credential back in the
        // clear, and it is the supported way for a client to obtain one. Every
        // other secret-reading path audits (`export_credential`,
        // `access_secret_version`, SSH agent forwarding); this one did not.
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "account.credentials.read",
            entityType: "account",
            entityId: accountId,
          }),
        );
        // Checked only for being a map: `respond` logs a mismatch with the
        // offending value, and these values are provider secrets.
        return yield* respond(CredentialsMap)(credentials);
      }),
    )
    // Rotate the credentials this account uses to talk to the upstream
    // provider: swap a stale or narrowly-scoped API token for a freshly-minted
    // one without losing the account's resources, pins, dashboards, or sync
    // history.
    .handleRaw("rotateCredentials", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const accountId = params.id;
        const submitted = (yield* fieldsOf(yield* readJson(request)))["credentials"];
        if (!submitted || typeof submitted !== "object") {
          return yield* badRequest("credentials object is required");
        }
        const credentials = yield* decodeAsPayload(StringMap, submitted);
        const [existing] = yield* legacy(() =>
          db
            .select({
              id: accounts.id,
              pluginId: accounts.pluginId,
              oauthStatus: accounts.oauthStatus,
              bastionId: accounts.bastionId,
            })
            .from(accounts)
            .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
            .limit(1),
        );
        if (!existing) return yield* notFound("Account not found");
        yield* refuseServerCredentials(existing.pluginId, credentials);
        const loaded = yield* legacy(() => getPlugin(existing.pluginId));
        const currentStatus: OAuthStatus | null =
          existing.oauthStatus === "connected" || existing.oauthStatus === "reconnect_required"
            ? existing.oauthStatus
            : null;

        // Merge against the stored credentials under the row lock, so the
        // write cannot race a token refresh and put back a rotated-away refresh
        // token. A sealed grant in the body (re)connects; no grant keeps the
        // stored one unless the token itself changed (see
        // `resolveCredentialUpdate`).
        const saved = yield* legacyTry(
          () =>
            postgresCredentialStore.withLockedCredentials(
              accountId,
              organizationId,
              async (stored) => {
                const next: AcceptedCredentials = loaded
                  ? await resolveCredentialUpdate(credentials, stored, {
                      manifest: loaded.plugin.manifest,
                      organizationId,
                      userId: session.userId,
                      currentStatus,
                    })
                  : { credentials: stripOAuthGrantState(credentials), oauthStatus: null };
                return {
                  result: next,
                  write: { credentials: next.credentials, oauthStatus: next.oauthStatus },
                };
              },
            ),
          oauthRefusal,
        );
        if (!saved) return yield* notFound("Account not found");
        yield* legacy(() =>
          db
            .update(accounts)
            .set({
              updatedAt: new Date(),
              // A credential edit is usually the fix for whatever the last poll
              // complained about: a blank billing-export table, a rotated key, a
              // missing role. Leaving the backoff in place means the account
              // sits out up to a day still showing the stale error telling the
              // user to do the thing they just did, so clear the failure state
              // and make both passes due now.
              nextPollAt: new Date(),
              pollFailureCount: 0,
              costNextPollAt: new Date(),
              costPollFailureCount: 0,
              costPollError: null,
              costPollErrorHelpLabel: null,
              costPollErrorHelpUrl: null,
            })
            .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId))),
        );
        // The edit may have moved the host this account configured.
        yield* refreshBastionAfterAccountChange(existing.bastionId);
        return yield* respond(RotatedCredentials)(ok);
      }),
    )
    .handle("resources", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const topLevelOnly = query.topLevelOnly === "true";
        const rows = yield* legacy(async () => {
          const conditions = [
            eq(resources.accountId, params.id),
            eq(resources.organizationId, organizationId),
            isNull(resources.deletedAt),
            ...(topLevelOnly ? await topLevelConditions() : []),
          ];
          return db
            .select(resourceColumns)
            .from(resources)
            .where(and(...conditions));
        });
        return yield* respond(Schema.Array(Resource))(rows);
      }),
    )
    // Terraform HCL for the account's stored inventory. Resources without a
    // mapping are listed as unsupported rather than dropped silently.
    .handle("exportTerraform", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const accountId = params.id;
        const [account] = yield* legacy(() =>
          db
            .select({ id: accounts.id, pluginId: accounts.pluginId })
            .from(accounts)
            .where(
              and(
                eq(accounts.id, accountId),
                eq(accounts.organizationId, organizationId),
                isNull(accounts.deletedAt),
              ),
            )
            .limit(1),
        );
        if (!account) return yield* notFound("Account not found");
        const outcome = yield* legacy(async () => {
          const rows = await db
            .select(resourceColumns)
            .from(resources)
            .where(
              and(
                eq(resources.accountId, accountId),
                eq(resources.organizationId, organizationId),
                isNull(resources.deletedAt),
              ),
            );
          // Stable ordering: top-level resources before children, then by id.
          const ordered = [...rows].sort(
            (a, b) =>
              (a.parentResourceId ? 1 : 0) - (b.parentResourceId ? 1 : 0) ||
              a.id.localeCompare(b.id),
          );
          return exportStoredResourcesToTerraform(ordered);
        });
        return yield* respond(TerraformExport)(outcome);
      }),
    )
    .handle("sync", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() => syncAccountResources(params.id, organizationId));
        return yield* respond(SyncResponse)({
          synced: result.resourceCount,
          ...(result.incompleteLists.length > 0 ? { incompleteLists: result.incompleteLists } : {}),
        });
      }),
    )
    // Account metadata and its resource types: no resources, no sync.
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [account] = yield* legacy(() =>
          db
            .select()
            .from(accounts)
            .where(and(eq(accounts.id, params.id), eq(accounts.organizationId, organizationId))),
        );
        if (!account) return yield* notFound("Account not found");

        const plugin = yield* legacy(() => getPlugin(account.pluginId));
        const resourceTypes =
          plugin?.plugin.resourceTypes.map((rt) => ({
            id: rt.id,
            displayName: rt.displayName,
            pluralDisplayName: rt.pluralDisplayName,
            ...(rt.iconKey ? { iconKey: rt.iconKey } : {}),
            showcase: showcaseFields(rt),
            parentTypeId: rt.parentTypeId,
            supportsCreate: rt.supportsCreate ?? false,
            // Both flags drive what the account page *opens to*, so the client
            // can't work them out from the rows alone: `showInSidebar` was
            // already missing here once and made web drop every child type
            // until you typed into the search box.
            ...(rt.showInSidebar ? { showInSidebar: true } : {}),
            ...(rt.accountRoot ? { accountRoot: true } : {}),
            ...(rt.attachTargets ? { attachTargets: rt.attachTargets } : {}),
            ...(rt.sshEndpoint ? { isSshHost: true } : {}),
            ...(rt.sshTunnelAttachSource ? { sshTunnelAttachSource: true } : {}),
            // Sleep/wake eligibility: the host never hard-codes provider names.
            ...(rt.lifecycle ? { schedulable: true } : {}),
          })) ?? [];

        return yield* respond(AccountDetail)({
          account: {
            id: account.id,
            pluginId: account.pluginId,
            displayName: account.displayName,
            oauthStatus: account.oauthStatus ?? null,
          },
          resourceTypes,
          pluginDisplayName: plugin?.plugin.manifest.displayName ?? "",
          pluginLogoSvg: plugin?.plugin.manifest.logoSvg ?? "",
        });
      }),
    )
    // Sync a single resource type and return its resources.
    .handle("syncType", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const fetched = yield* legacy(() =>
          syncAccountResourceType(params.id, organizationId, params.typeId),
        ).pipe(Effect.catchDefect((defect) => Effect.die(syncTypeFailure(defect))));
        return yield* respond(Schema.Array(SyncedResource))(
          fetched.map((r) => ({
            id: r.id,
            pluginId: r.pluginId,
            resourceTypeId: r.resourceTypeId,
            displayName: r.displayName,
            externalId: r.externalId ?? null,
            fieldsJson: r.fields ?? {},
            outputsJson: r.resolvedOutputs ?? {},
            parentResourceId: r.parentResourceId ?? null,
          })),
        );
      }),
    ),
);

export const accountsDomain = makeDomain("accounts", AccountsApi, AccountsHandlers);
