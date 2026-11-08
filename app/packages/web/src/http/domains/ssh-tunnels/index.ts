/**
 * SSH tunnels: `/api/org/:orgId/ssh-tunnels`, the handlers.
 *
 * The tunnels themselves live in this process (`services/ssh-tunnel.ts`), so
 * every route here is on the session gateway. The SSRF guard runs on each
 * bastion host the server is about to dial; the private key used is always
 * one the caller owns.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { OAUTH_CREDENTIAL_KEY, type SshTunnelConfig } from "@infrawrench/plugin-base";
import {
  OAuthCredentialError,
  acceptSubmittedCredentials,
  type AcceptedCredentials,
} from "@infrawrench/server-core/provider-oauth";
import {
  ActiveTunnel,
  BadRequest,
  badRequest,
  forbidden,
  notFound,
  ok,
  OpenedTunnel,
  SshExecResponse,
  SshTunnelCreateAccountResponse,
  SshTunnelsApi,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { accounts, sshKeys, sshTunnelConfigs } from "../../../db/schema";
import { buildAad, decrypt, encrypt } from "../../../services/encryption";
import { closeTunnel, getActiveTunnels, openTunnel } from "../../../services/ssh-tunnel";
import { sshExec } from "../../../services/ssh";
import { HostKeyTrustRequiredError } from "../../../services/ssh-host-keys";
import { resolveSafeHost } from "../../../services/host-validation";
import { logAudit } from "../../../services/audit";
import { getPlugin } from "../../../plugins/loader";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { hostKeyTrustRefusal, hostKeyTrustRequired } from "../ssh-host-key-trust";

const messageOr = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * The SSRF guard on a bastion host: the address it cleared, or the 400. The
 * routes that open a tunnel discard the address (`openTunnel` resolves again
 * and dials what *it* cleared); exec keeps it, since `sshExec` dials as given.
 */
const safeHost = (host: string) =>
  legacyTry(
    () => resolveSafeHost(host),
    (error) => new BadRequest({ error: messageOr(error, "Invalid SSH host") }),
  );

/** One of the caller's own SSH private keys: same-org peers cannot use another user's. */
const callerPrivateKey = (organizationId: string, userId: string, sshKeyId: string) =>
  Effect.gen(function* () {
    const [keyRow] = yield* legacy(() =>
      db
        .select({
          encryptedPrivateKey: sshKeys.encryptedPrivateKey,
          privateKeyIv: sshKeys.privateKeyIv,
        })
        .from(sshKeys)
        .where(
          and(
            eq(sshKeys.id, sshKeyId),
            eq(sshKeys.organizationId, organizationId),
            eq(sshKeys.userId, userId),
          ),
        )
        .limit(1),
    );
    if (!keyRow) return yield* notFound("SSH key not found");
    const { encryptedPrivateKey, privateKeyIv } = keyRow;
    if (!encryptedPrivateKey || !privateKeyIv) {
      return yield* badRequest("SSH key has no private key data");
    }
    return yield* legacy(() =>
      decrypt(encryptedPrivateKey, privateKeyIv, buildAad("sshKey", sshKeyId, "privateKey")),
    );
  });

const SshTunnelsHandlers = HttpApiBuilder.group(SshTunnelsApi, "sshTunnels", (handlers) =>
  handlers
    /** Create an account with an SSH tunnel config in one step, after testing the tunnel. */
    .handle("createAccount", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // Only `sshHost` (the public bastion the server dials) is checked; the
        // inner `remoteHost` is allowed to be private, that's the point.
        yield* safeHost(input.sshHost);
        const privateKey = yield* callerPrivateKey(organizationId, session.userId, input.sshKeyId);

        const tunnelConfig: SshTunnelConfig = {
          sshHost: input.sshHost,
          sshPort: input.sshPort,
          sshUser: input.sshUser,
          privateKey,
          remoteHost: input.remoteHost,
          remotePort: input.remotePort,
        };

        // Same `__oauth` handling as a plain account create: a sealed grant from
        // the Connect flow becomes real grant state, anything else is refused.
        let opened: AcceptedCredentials = { credentials: input.credentials, oauthStatus: null };
        const loadedPlugin = input.credentials[OAUTH_CREDENTIAL_KEY]
          ? yield* legacy(() => getPlugin(input.pluginId))
          : undefined;
        if (loadedPlugin) {
          opened = yield* legacyTry(
            () =>
              acceptSubmittedCredentials(input.credentials, {
                manifest: loadedPlugin.plugin.manifest,
                organizationId,
                userId: session.userId,
              }),
            (error) =>
              error instanceof OAuthCredentialError
                ? new BadRequest({ error: error.message })
                : undefined,
          );
        }

        const newAccountId = uuid();
        yield* legacyTry(
          () => openTunnel(tunnelConfig, organizationId, newAccountId),
          (error) =>
            error instanceof HostKeyTrustRequiredError
              ? hostKeyTrustRequired(error)
              : new BadRequest({
                  error: `SSH tunnel failed: ${messageOr(error, "Unknown error")}`,
                }),
        );

        const tunnelConfigId = uuid();
        const credentials = opened.credentials;
        const { ciphertext: credCiphertext, iv: credIv } = yield* legacy(() =>
          encrypt(JSON.stringify(credentials), buildAad("account", newAccountId, "credentials")),
        );
        const { ciphertext: keyCiphertext, iv: keyIv } = yield* legacy(() =>
          encrypt(privateKey, buildAad("sshTunnelConfig", tunnelConfigId, "privateKey")),
        );
        const oauthStatus = opened.oauthStatus;
        yield* legacy(() =>
          db.insert(accounts).values({
            id: newAccountId,
            organizationId,
            pluginId: input.pluginId,
            displayName: input.displayName,
            encryptedCredentials: credCiphertext,
            credentialsIv: credIv,
            oauthStatus,
          }),
        );
        yield* legacy(() =>
          db.insert(sshTunnelConfigs).values({
            id: tunnelConfigId,
            accountId: newAccountId,
            organizationId,
            sshHost: input.sshHost,
            sshPort: input.sshPort,
            sshUser: input.sshUser,
            remoteHost: input.remoteHost,
            remotePort: input.remotePort,
            encryptedPrivateKey: keyCiphertext,
            privateKeyIv: keyIv,
          }),
        );
        return yield* respond(SshTunnelCreateAccountResponse)({ accountId: newAccountId });
      }),
    )
    /** Open the tunnel of an existing account that has an `ssh_tunnel_configs` row. */
    .handle("open", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [config] = yield* legacy(() =>
          db
            .select()
            .from(sshTunnelConfigs)
            .where(
              and(
                eq(sshTunnelConfigs.accountId, input.accountId),
                eq(sshTunnelConfigs.organizationId, organizationId),
              ),
            )
            .limit(1),
        );
        if (!config) return yield* notFound("No tunnel config for this account");
        // The create flow vetted this host at write time, but DNS records can
        // change. As there, the address is `openTunnel`'s to pin.
        yield* safeHost(config.sshHost);
        const privateKey = yield* legacy(() =>
          decrypt(
            config.encryptedPrivateKey,
            config.privateKeyIv,
            buildAad("sshTunnelConfig", config.id, "privateKey"),
          ),
        );
        const result = yield* legacyTry(
          () =>
            openTunnel(
              {
                sshHost: config.sshHost,
                sshPort: config.sshPort,
                sshUser: config.sshUser,
                privateKey,
                remoteHost: config.remoteHost,
                remotePort: config.remotePort,
              },
              organizationId,
              input.accountId,
            ),
          hostKeyTrustRefusal,
        );
        return yield* respond(OpenedTunnel)(result);
      }),
    )
    .handle("close", ({ payload }) =>
      Effect.gen(function* () {
        yield* legacy(() => Promise.resolve(closeTunnel(payload.tunnelId)));
        return ok;
      }),
    )
    .handle("active", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const all = yield* legacy(() => Promise.resolve(getActiveTunnels()));
        const result: Record<string, { localPort: number; sshHost: string; remotePort: number }> =
          {};
        for (const [id, info] of Object.entries(all)) {
          if (info.organizationId === organizationId) {
            result[id] = {
              localPort: info.localPort,
              sshHost: info.sshHost,
              remotePort: info.remotePort,
            };
          }
        }
        return yield* respond(Schema.Record(Schema.String, ActiveTunnel))(result);
      }),
    )
    /**
     * Run a command over SSH with one of the caller's keys. The (host, port,
     * user) triple must match an admin-configured tunnel config of this org,
     * or `resources:execute` would be "run anything as anyone anywhere".
     * Every attempt, successful or not, is audit-logged.
     */
    .handle("exec", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // Nothing downstream re-resolves for this route (`sshExec` dials what it
        // is given), so the cleared address is kept and the name resolved once.
        const dialAddress = yield* safeHost(input.sshHost);

        const matchingConfigs = yield* legacy(() =>
          db
            .select({ id: sshTunnelConfigs.id, accountId: sshTunnelConfigs.accountId })
            .from(sshTunnelConfigs)
            .where(
              and(
                eq(sshTunnelConfigs.organizationId, organizationId),
                eq(sshTunnelConfigs.sshHost, input.sshHost),
                eq(sshTunnelConfigs.sshUser, input.sshUser),
                eq(sshTunnelConfigs.sshPort, input.sshPort),
              ),
            )
            .limit(1),
        );
        const [matching] = matchingConfigs;
        if (!matching) {
          return yield* forbidden(
            "The requested SSH host/user combination is not configured for this organization. Ask an admin to create an SSH tunnel config first.",
          );
        }

        const privateKey = yield* callerPrivateKey(organizationId, session.userId, input.sshKeyId);
        const commandSnippet = input.command.slice(0, 200);
        const auditBase = {
          organizationId,
          userId: session.userId,
          entityType: "ssh-tunnel-exec",
          entityId: matching.accountId,
        };
        const auditTarget = {
          sshHost: input.sshHost,
          sshUser: input.sshUser,
          sshKeyId: input.sshKeyId,
          commandSnippet,
        };

        const outcome = yield* legacy(() =>
          sshExec(
            organizationId,
            { host: input.sshHost, port: input.sshPort, username: input.sshUser, privateKey },
            input.command,
            { dialAddress },
          ).then(
            (stdout) => ({ ok: true as const, stdout }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        if (outcome.ok) {
          yield* fireAndForget(() =>
            logAudit({
              ...auditBase,
              action: "ssh.exec",
              metadata: { ...auditTarget, exitCode: 0 },
            }),
          );
          return yield* respond(SshExecResponse)({ stdout: outcome.stdout, code: 0 });
        }
        // sshExec throws on a non-zero exit OR a host-key trust failure. The
        // latter needs the structured 409 so the client can prompt.
        const error = outcome.error;
        if (error instanceof HostKeyTrustRequiredError) {
          yield* fireAndForget(() =>
            logAudit({
              ...auditBase,
              action: "ssh.exec.host_key_trust_required",
              metadata: {
                ...auditTarget,
                kind: error.kind,
                presentedFingerprint: error.presentedFingerprint,
              },
            }),
          );
          return yield* hostKeyTrustRequired(error);
        }
        const message = messageOr(error, "Command failed");
        yield* fireAndForget(() =>
          logAudit({
            ...auditBase,
            action: "ssh.exec.failed",
            metadata: { ...auditTarget, error: message },
          }),
        );
        return yield* respond(SshExecResponse)({ stdout: "", stderr: message, code: 1 });
      }),
    ),
);

export const sshTunnelsDomain = makeDomain("ssh-tunnels", SshTunnelsApi, SshTunnelsHandlers);
