/**
 * Connection features, the handlers: SQL, KV, Docker, storage, artifacts and
 * SFTP against live resources.
 *
 * Every plugin call and socket driver call goes through `legacy`, so it starts
 * synchronously inside the request's scopes (the client's egress scope, the
 * edge request scope's gateway-only tracker). The SQL routes' driver
 * selection is promise code below, run as one `legacy` call each. A connection
 * the egress guard refuses is a defect, rendered as the API always has.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { guardDriverConnection } from "@infrawrench/server-core/egress-guard";
import {
  BadRequest,
  badRequest,
  ConnectionsApi,
  DockerCommandResponse,
  InternalServerError,
  JsonObject,
  KvCommandResponse,
  NotFound,
  notFound,
  ok,
  SftpEntries,
  SqlExecuteResponse,
  SqlQueryResult,
  StorageObjects,
  Undocumented,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { dockerDrivers, kvDrivers, sqlDrivers } from "../../../services/drivers";
import { getClientForAccount, getClientForResource } from "../../../services/plugin-clients";
import { sftpDelete, sftpList, sftpMkdir } from "../../../services/sftp";
import { resolveSshConfig } from "../../../services/ssh";
import { rewriteConnectionForTunnel } from "../../../services/tunnel-resolver";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type AccountClient = NonNullable<Awaited<ReturnType<typeof getClientForAccount>>>;

/** The refusals the SQL flows throw, brought back into the typed channel. */
const operation = <A>(fn: () => Promise<A>) =>
  legacyTry(fn, (error): BadRequest | NotFound | undefined =>
    error instanceof BadRequest || error instanceof NotFound ? error : undefined,
  );

const accountClient = Effect.fnUntraced(function* (accountId: string) {
  const { organizationId } = yield* OrgPrincipal;
  const ctx = yield* legacy(() => getClientForAccount(accountId, organizationId));
  if (!ctx) return yield* notFound("Account not found");
  return ctx;
});

/** A client method the plugin may not implement, bound to its client, or the route's 400. */
const capability = <F>(method: F | undefined, unsupported: string) =>
  method === undefined ? Effect.fail(badRequest(unsupported)) : Effect.succeed(method);

/**
 * The routes whose every failure, the account lookup included, answered
 * `500 { error }` with the error's message (artifact listing, SFTP). Their
 * 400 and 404 refusals pass through as they were.
 */
const asServerError =
  (fallback: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          new InternalServerError({ error: defect instanceof Error ? defect.message : fallback }),
        ),
      ),
    );

interface SqlInput {
  readonly accountId: string;
  readonly resourceId?: string | undefined;
  readonly resourceTypeId?: string | undefined;
  readonly sql: string;
}

/**
 * The connection string a statement runs against: a per-resource SQL driver
 * (Neon, Turso) when the type declares one, else the account-level driver
 * (Postgres, MySQL), rewritten through the account's tunnel and cleared by
 * the egress guard. Throws the route's 400 for an unknown driver or none.
 */
async function sqlTarget(ctx: AccountClient, organizationId: string, input: SqlInput) {
  const { client, plugin, credentials } = ctx;
  if (input.resourceId && input.resourceTypeId) {
    const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === input.resourceTypeId);
    const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
    if (rtSqlDriver) {
      let connectionString = await client.resolveOutput(
        input.resourceTypeId,
        input.resourceId,
        rtSqlDriver.connectionStringOutputKey,
        input.accountId,
      );
      connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
      const driver = sqlDrivers.get(rtSqlDriver.driver);
      if (!driver) throw new BadRequest({ error: `Unknown SQL driver: ${rtSqlDriver.driver}` });
      await guardDriverConnection(driver, connectionString, {
        accountId: input.accountId,
        organizationId,
      });
      return { driver, connectionString };
    }
  }

  const manifest = plugin.manifest;
  if (manifest.sqlDriver) {
    let connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    connectionString = await rewriteConnectionForTunnel(input.accountId, connectionString);
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver)
      throw new BadRequest({ error: `Unknown SQL driver: ${manifest.sqlDriver.driver}` });
    await guardDriverConnection(driver, connectionString, {
      accountId: input.accountId,
      organizationId,
    });
    return { driver, connectionString };
  }

  throw new BadRequest({ error: "No SQL driver available" });
}

/** `POST /sql/query`: REST `executeQuery` (BigQuery, Databricks) first, else a driver. */
async function runSqlQuery(ctx: AccountClient, organizationId: string, input: SqlInput) {
  if (input.resourceId && ctx.client.executeQuery) {
    return ctx.client.executeQuery(input.resourceId, input.accountId, input.sql);
  }
  const { driver, connectionString } = await sqlTarget(ctx, organizationId, input);
  const start = Date.now();
  const rows = await driver.query(connectionString, input.sql);
  return { rows, durationMs: Date.now() - start };
}

const ConnectionsHandlers = HttpApiBuilder.group(ConnectionsApi, "connections", (handlers) =>
  handlers
    .handle("sqlQuery", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const ctx = yield* accountClient(input.accountId);
        const result = yield* operation(() => runSqlQuery(ctx, organizationId, input));
        return yield* respond(SqlQueryResult)(result);
      }),
    )
    .handle("sqlExecute", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const ctx = yield* accountClient(input.accountId);
        // Every attempt is audited: a mutating statement bypasses the
        // per-resource UI, so it must always be traceable to a user. The
        // statement is cut to 200 characters to bound the metadata and keep
        // large bind values out of it.
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "sql.execute",
            entityType: "account",
            entityId: input.accountId,
            metadata: {
              resourceId: input.resourceId,
              resourceTypeId: input.resourceTypeId,
              sqlSnippet: input.sql.slice(0, 200),
            },
          }),
        );
        const affectedRows = yield* operation(async () => {
          const { driver, connectionString } = await sqlTarget(ctx, organizationId, input);
          return driver.execute(connectionString, input.sql, input.params ?? []);
        });
        return yield* respond(SqlExecuteResponse)({ affectedRows });
      }),
    )
    .handle("sqlEstimate", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const estimate = yield* capability(
          client.estimateQueryCost?.bind(client),
          "Query cost estimation is not supported for this resource",
        );
        const result = yield* legacy(() => estimate(input.resourceId, input.accountId, input.sql));
        return yield* respond(JsonObject)(result);
      }),
    )
    .handle("kvCommand", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { pluginId, accountId, parentResourceId } = input;
        const ctx = yield* legacy(() =>
          pluginId
            ? getClientForResource(pluginId, accountId, organizationId, parentResourceId)
            : getClientForAccount(accountId, organizationId),
        );
        if (!ctx) return yield* notFound("Account not found");
        const { plugin, credentials } = ctx;
        const kvDriver = plugin.manifest.kvDriver;
        if (!kvDriver) return yield* badRequest("No KV driver available");
        const result = yield* operation(async () => {
          const connectionString = await rewriteConnectionForTunnel(
            accountId,
            credentials[kvDriver.credentialKey] ?? "",
          );
          const driver = kvDrivers.get(kvDriver.driver);
          if (!driver) throw new BadRequest({ error: `Unknown KV driver: ${kvDriver.driver}` });
          await guardDriverConnection(driver, connectionString, { accountId, organizationId });
          return driver.command(connectionString, input.command, input.args);
        });
        return yield* respond(KvCommandResponse)({ result });
      }),
    )
    .handle("dockerCommand", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { accountId } = input;
        const { plugin, credentials } = yield* accountClient(accountId);
        const dockerDriver = plugin.manifest.dockerDriver;
        if (!dockerDriver) return yield* badRequest("No Docker driver available");
        const result = yield* operation(async () => {
          const dockerHost = await rewriteConnectionForTunnel(
            accountId,
            credentials[dockerDriver.credentialKey] ?? "",
          );
          const driver = dockerDrivers.get(dockerDriver.driver);
          if (!driver) {
            throw new BadRequest({ error: `Unknown Docker driver: ${dockerDriver.driver}` });
          }
          await guardDriverConnection(driver, dockerHost, { accountId, organizationId });
          return driver.command(dockerHost, input.op, input.params);
        });
        return yield* respond(DockerCommandResponse)({ result });
      }),
    )
    .handle("kvBrowserList", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const list = yield* capability(
          client.listKvKeys?.bind(client),
          "Plugin does not support KV listing",
        );
        const params: { prefix?: string; cursor?: string; limit?: number } = {};
        if (input.prefix != null) params.prefix = input.prefix;
        if (input.cursor != null) params.cursor = input.cursor;
        if (input.limit != null) params.limit = input.limit;
        const result = yield* legacy(() =>
          list(input.resourceTypeId, input.resourceId, input.accountId, params),
        );
        return yield* respond(Undocumented)(result);
      }),
    )
    .handle("kvBrowserGet", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const get = yield* capability(
          client.getKvValue?.bind(client),
          "Plugin does not support KV reads",
        );
        const value = yield* legacy(() =>
          get(input.resourceTypeId, input.resourceId, input.accountId, input.key),
        );
        return yield* respond(Undocumented)({ value });
      }),
    )
    .handle("kvBrowserPut", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const put = yield* capability(
          client.putKvValue?.bind(client),
          "Plugin does not support KV writes",
        );
        yield* legacy(() =>
          put(input.resourceTypeId, input.resourceId, input.accountId, input.key, input.value),
        );
        return ok;
      }),
    )
    .handle("kvBrowserDelete", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const remove = yield* capability(
          client.deleteKvKey?.bind(client),
          "Plugin does not support KV deletes",
        );
        yield* legacy(() =>
          remove(input.resourceTypeId, input.resourceId, input.accountId, input.key),
        );
        return ok;
      }),
    )
    .handle("storageList", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const list = yield* capability(
          client.listStorageObjects?.bind(client),
          "Plugin does not support storage listing",
        );
        const result = yield* legacy(() => list(input.bucket, input.prefix));
        return yield* respond(StorageObjects)(result);
      }),
    )
    .handle("storageMkdir", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const mkdir = yield* capability(
          client.makeStorageFolder?.bind(client),
          "Plugin does not support folder creation",
        );
        yield* legacy(() => mkdir(input.bucket, input.key));
        return ok;
      }),
    )
    .handle("storageDelete", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const remove = yield* capability(
          client.deleteStorageObject?.bind(client),
          "Plugin does not support object deletion",
        );
        yield* legacy(() => remove(input.bucket, input.key));
        return ok;
      }),
    )
    .handle("artifactsList", ({ payload: input }) =>
      Effect.gen(function* () {
        const { client } = yield* accountClient(input.accountId);
        const list = yield* capability(
          client.listArtifacts?.bind(client),
          "Plugin does not support artifact listing",
        );
        const params: { pageToken?: string; prefix?: string } = {};
        if (input.pageToken) params.pageToken = input.pageToken;
        if (input.prefix) params.prefix = input.prefix;
        const result = yield* legacy(() =>
          list(input.resourceTypeId, input.resourceId, input.accountId, params),
        );
        return yield* respond(JsonObject)(result);
      }).pipe(asServerError("Artifact list failed")),
    )
    .handle("sftpList", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { client } = yield* accountClient(input.accountId);
        const result = yield* legacy(async () => {
          const config = await resolveSshConfig(client, organizationId, input);
          return sftpList(organizationId, config, input.path);
        });
        return yield* respond(SftpEntries)(result);
      }).pipe(asServerError("SFTP list failed")),
    )
    .handle("sftpMkdir", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { client } = yield* accountClient(input.accountId);
        yield* legacy(async () => {
          const config = await resolveSshConfig(client, organizationId, input);
          await sftpMkdir(organizationId, config, input.path);
        });
        return ok;
      }).pipe(asServerError("SFTP mkdir failed")),
    )
    .handle("sftpDelete", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { client } = yield* accountClient(input.accountId);
        yield* legacy(async () => {
          const config = await resolveSshConfig(client, organizationId, input);
          await sftpDelete(organizationId, config, input.path, input.isDir);
        });
        return ok;
      }).pipe(asServerError("SFTP delete failed")),
    ),
);

export const connectionFeaturesDomain = makeDomain(
  "connection-features",
  ConnectionsApi,
  ConnectionsHandlers,
);
