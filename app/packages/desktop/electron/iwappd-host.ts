/**
 * Linux application sessions, main-process side.
 *
 * The renderer resolves which host to connect to and with which key (exactly
 * as it does for an SSH tab) and this opens the connection, puts `iwappd` into
 * the host's RAM, runs it, and relays protocol frames both ways.
 *
 * The connection itself is `connectSshChain` from `ssh-shell.ts`, so jump
 * hosts, agent forwarding and the TOFU host-key check behave identically to a
 * terminal. Everything above the connection is `@infrawrench/appstream-host`,
 * shared with the web server.
 *
 * Served as the `Apps*` RPCs (`shared/rpc/groups/linux-apps.ts`): a session
 * and an install are each one stream whose scope owns the connection.
 */

import * as crypto from "node:crypto";
import type { Client as SshClient } from "ssh2";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import {
  checkHost,
  installRequirements,
  listApps,
  planInstall,
  probeHost,
  startAppServer,
  type AppServerSession,
  type RequirementId,
} from "@infrawrench/appstream-host";

import { errorMessage } from "../shared/rpc/errors";
import {
  AppEntry,
  LinuxAppsError,
  type AppsInstallEvent,
  type AppsSessionEvent,
  type HostRequirementsCheck,
} from "../shared/rpc/groups/linux-apps";
import { acquireSshChain, type SshConnectConfig } from "./ssh-shell";
import { getArm64GzBinary, getx86_64GzBinary } from "./iwappd-archive";

interface SessionRecord {
  readonly session: AppServerSession;
  /** The RPC client (renderer connection) that opened it; only it may write. */
  readonly owner: number;
}

const sessions = new Map<string, SessionRecord>();

/** Which gzipped binary to send, decided by the host's own architecture. */
const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

const toAppsError = (cause: unknown) => new LinuxAppsError({ message: errorMessage(cause) });

/** The connection as a scoped resource, failing with this group's error. */
const connect = (config: SshConnectConfig) =>
  acquireSshChain(config).pipe(
    Effect.mapError((error) => new LinuxAppsError({ message: error.message })),
  );

/**
 * Start the app server on a connected client as a scoped resource: releasing
 * it closes the server (the chain's own release then ends the connection).
 */
const acquireSession = (
  client: SshClient,
  sessionId: string,
  owner: number,
  emit: (event: AppsSessionEvent) => void,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        startAppServer(client, {
          sessionId,
          binaryForArch,
          // The host outlives a dropped connection by design, but not for long:
          // nobody should discover a forgotten compositor on their VM next week.
          idleTimeoutSecs: 30 * 60,
          onProgress: (stage) => emit({ _tag: "Progress", stage }),
          onStderr: (line) => {
            console.warn(`[iwappd ${sessionId.slice(0, 8)}] ${line}`);
            emit({ _tag: "Stderr", line });
          },
        }),
      catch: toAppsError,
    }),
    (session) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
        try {
          session.close();
        } catch {
          /* already gone */
        }
      }),
  ).pipe(Effect.tap((session) => Effect.sync(() => sessions.set(sessionId, { session, owner }))));

/**
 * Open a session: connect, stage the binary in RAM, exec it, and forward
 * frames until the app server exits.
 */
const openSession = (config: SshConnectConfig, owner: number) =>
  Stream.callback<AppsSessionEvent, LinuxAppsError>((queue) =>
    Effect.gen(function* () {
      const emit = (event: AppsSessionEvent) => {
        Queue.offerUnsafe(queue, event);
      };
      const { client } = yield* connect(config);
      const sessionId = crypto.randomUUID();
      const session = yield* acquireSession(client, sessionId, owner, emit);
      // A copy, because ssh2 reuses its read buffers.
      session.onData((chunk) => emit({ _tag: "Data", data: new Uint8Array(chunk) }));
      session.onClose(() => {
        sessions.delete(sessionId);
        Queue.endUnsafe(queue);
      });
      emit({ _tag: "Opened", sessionId });
    }),
  );

const decodeApps = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(AppEntry)));

/**
 * The host's applications without opening a session: one exec that uploads,
 * lists and deletes. What the launcher paints first.
 */
const listHostApps = (config: SshConnectConfig, iconSize: number | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { client } = yield* connect(config);
      const raw = yield* Effect.tryPromise({
        try: () =>
          listApps(client, {
            binaryForArch,
            ...(iconSize !== undefined ? { iconSize } : {}),
          }),
        catch: toAppsError,
      });
      return yield* decodeApps(raw).pipe(
        Effect.mapError(
          (issue) =>
            new LinuxAppsError({
              message: `The app server listed its apps oddly: ${issue.message}`,
            }),
        ),
      );
    }),
  );

/**
 * What the host is missing, before anything is uploaded.
 *
 * Its own connection rather than the session's, because the whole point is to
 * answer on a host where starting a session would fail: no `gunzip` and the
 * staging step cannot even unpack the binary.
 */
const preflightHost = (config: SshConnectConfig) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { client } = yield* connect(config);
      return yield* Effect.tryPromise({ try: () => checkHost(client), catch: toAppsError });
    }),
  );

/**
 * Install what the host is missing, streaming the package manager's output
 * back so the renderer can show it.
 *
 * The plan is rebuilt here from a fresh probe rather than taken from the
 * renderer: the renderer chooses *which* requirements to install, and the
 * commands that then run are ours. A renderer that could hand over a command
 * line would be an arbitrary-root-command channel wearing a helpful hat.
 */
const installOnHost = (config: SshConnectConfig, include: readonly RequirementId[] | undefined) =>
  Stream.callback<AppsInstallEvent, LinuxAppsError>((queue) =>
    Effect.gen(function* () {
      const { client } = yield* connect(config);
      const emit = (line: string) => {
        Queue.offerUnsafe(queue, { _tag: "Output", line });
      };
      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const preflight = await probeHost(client);
          const plan = planInstall(preflight, include ? { include: [...include] } : {});
          if (!plan) return { log: [], failed: [], preflight };
          for (const command of plan.commands) emit(`$ ${command}`);
          return await installRequirements(client, plan, { onOutput: emit });
        },
        catch: toAppsError,
      });
      Queue.offerUnsafe(queue, { _tag: "Done", outcome });
      Queue.endUnsafe(queue);
    }),
  );

export class LinuxApps extends Context.Service<
  LinuxApps,
  {
    readonly open: (
      config: SshConnectConfig,
      owner: number,
    ) => Stream.Stream<AppsSessionEvent, LinuxAppsError>;
    readonly write: (sessionId: string, owner: number, data: Uint8Array) => Effect.Effect<void>;
    readonly list: (
      config: SshConnectConfig,
      iconSize: number | undefined,
    ) => Effect.Effect<Array<typeof AppEntry.Type>, LinuxAppsError>;
    readonly preflight: (
      config: SshConnectConfig,
    ) => Effect.Effect<HostRequirementsCheck, LinuxAppsError>;
    readonly install: (
      config: SshConnectConfig,
      include: readonly RequirementId[] | undefined,
    ) => Stream.Stream<AppsInstallEvent, LinuxAppsError>;
  }
>()("infrawrench/desktop/LinuxApps") {
  static readonly layer = Layer.succeed(LinuxApps)(
    LinuxApps.of({
      open: openSession,
      write: (sessionId, owner, data) =>
        Effect.sync(() => {
          const record = sessions.get(sessionId);
          if (record?.owner === owner) record.session.write(Buffer.from(data));
        }),
      list: listHostApps,
      preflight: preflightHost,
      install: installOnHost,
    }),
  );
}

/**
 * Close every session: called when the app quits. Each close ends its
 * stream, whose scope then ends the connection.
 */
export function shutdownIwappdSessions(): void {
  for (const { session } of [...sessions.values()]) {
    try {
      session.close();
    } catch {
      /* already gone */
    }
  }
}
