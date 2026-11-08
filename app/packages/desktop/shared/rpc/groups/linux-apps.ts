/**
 * Linux applications over SSH (`electron/iwappd-host.ts`): the app server
 * `iwappd` staged in a host's RAM, its protocol frames relayed both ways.
 *
 * A session is one streaming call, `AppsSessionOpen`: it connects (the same
 * `connectSshChain` an SSH tab uses), streams `Progress` while the binary is
 * staged and started, then `Opened` with the id `AppsSessionWrite`
 * addresses, then the app server's frames (`Data`) and diagnostics
 * (`Stderr`). The stream ends when the app server exits. Interrupting it,
 * which is what the last tab letting go of the host does, and the renderer
 * going away both close the app server and the connection.
 *
 * `AppsInstall` streams the package manager's output the same way and ends
 * with the outcome.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  AppEntry as AppEntryType,
  HostPreflight as HostPreflightType,
  HostRequirementsCheck as HostRequirementsCheckType,
  InstallOutcome as InstallOutcomeType,
  InstallPlan as InstallPlanType,
  RequirementStatus as RequirementStatusType,
} from "@infrawrench/appstream-core";
import { exact } from "../exact";
import { SshJumpHop } from "./ssh-common";

/** What `connectSshChain` dials, without the PTY size a shell needs. */
export const AppsConnectConfig = Schema.Struct({
  host: Schema.String,
  port: Schema.Finite,
  username: Schema.String,
  privateKey: Schema.String,
  agentForward: Schema.optionalKey(Schema.Boolean),
  /** Set when `privateKey` is the cloud-key sentinel; its private half stays in the cloud. */
  cloudKey: Schema.optionalKey(Schema.Struct({ orgId: Schema.String, sshKeyId: Schema.String })),
  jumpHops: Schema.optionalKey(Schema.Array(SshJumpHop)),
});
export type AppsConnectConfig = typeof AppsConnectConfig.Type;

export const AppEntry = exact<AppEntryType>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    comment: Schema.optionalKey(Schema.String),
    categories: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
    icon: Schema.optionalKey(Schema.String),
    wmClass: Schema.optionalKey(Schema.String),
    needsTerminal: Schema.optionalKey(Schema.Boolean),
  }),
);

const RequirementId = Schema.Literals(["gzip", "xkb", "dbus", "fonts", "mesa", "icons"]);
const PackageManager = Schema.Literals(["apt-get", "dnf", "yum", "apk", "pacman", "zypper"]);
const HostPrivilege = Schema.Literals(["root", "sudo", "sudo-password", "none"]);

const RequirementStatus = exact<RequirementStatusType>()(
  Schema.Struct({
    id: RequirementId,
    severity: Schema.Literals(["required", "recommended"]),
    title: Schema.String,
    summary: Schema.String,
    ok: Schema.Boolean,
  }),
);

const HostPreflight = exact<HostPreflightType>()(
  Schema.Struct({
    arch: Schema.String,
    osId: Schema.String,
    osName: Schema.String,
    packageManager: Schema.NullOr(PackageManager),
    privilege: HostPrivilege,
    requirements: Schema.mutable(Schema.Array(RequirementStatus)),
    staging: Schema.Boolean,
    appCount: Schema.Int,
    ready: Schema.Boolean,
  }),
);

const InstallPlan = exact<InstallPlanType>()(
  Schema.Struct({
    packageManager: PackageManager,
    privilege: HostPrivilege,
    requirements: Schema.mutable(Schema.Array(RequirementId)),
    packages: Schema.mutable(Schema.Array(Schema.String)),
    commands: Schema.mutable(Schema.Array(Schema.String)),
    canInstall: Schema.Boolean,
    blockedReason: Schema.optionalKey(Schema.String),
  }),
);

export const HostRequirementsCheck = exact<HostRequirementsCheckType>()(
  Schema.Struct({ preflight: HostPreflight, plan: Schema.NullOr(InstallPlan) }),
);
export type HostRequirementsCheck = typeof HostRequirementsCheck.Type;

export const InstallOutcome = exact<InstallOutcomeType>()(
  Schema.Struct({
    log: Schema.mutable(Schema.Array(Schema.String)),
    failed: Schema.mutable(Schema.Array(Schema.String)),
    preflight: HostPreflight,
  }),
);

export const AppsSessionEvent = Schema.Union([
  Schema.TaggedStruct("Progress", {
    stage: Schema.Literals(["detecting", "uploading", "starting", "ready"]),
  }),
  /** The app server is running; `sessionId` addresses `AppsSessionWrite`. */
  Schema.TaggedStruct("Opened", { sessionId: Schema.String }),
  /** One chunk of the app server's protocol stream. */
  Schema.TaggedStruct("Data", { data: Schema.Uint8Array }),
  /** A line the app server wrote to stderr. */
  Schema.TaggedStruct("Stderr", { line: Schema.String }),
]);
export type AppsSessionEvent = typeof AppsSessionEvent.Type;

export const AppsInstallEvent = Schema.Union([
  /** A command about to run (`$ …`) or a line of its output. */
  Schema.TaggedStruct("Output", { line: Schema.String }),
  Schema.TaggedStruct("Done", { outcome: InstallOutcome }),
]);
export type AppsInstallEvent = typeof AppsInstallEvent.Type;

/** The connection, the staging step or the host's answer failed; the message says which. */
export class LinuxAppsError extends Schema.TaggedError<LinuxAppsError>()("LinuxAppsError", {
  message: Schema.String,
}) {}

export class LinuxAppsRpcs extends RpcGroup.make(
  Rpc.make("AppsSessionOpen", {
    payload: AppsConnectConfig,
    success: AppsSessionEvent,
    error: LinuxAppsError,
    stream: true,
  }),
  /** Frames for an open session. A session this renderer does not own is ignored. */
  Rpc.make("AppsSessionWrite", {
    payload: { sessionId: Schema.String, data: Schema.Uint8Array },
  }),
  /** The host's applications without opening a session: what the launcher paints first. */
  Rpc.make("AppsList", {
    payload: { config: AppsConnectConfig, iconSize: Schema.optionalKey(Schema.Int) },
    success: Schema.mutable(Schema.Array(AppEntry)),
    error: LinuxAppsError,
  }),
  /** What the host is missing, before anything is uploaded. */
  Rpc.make("AppsPreflight", {
    payload: { config: AppsConnectConfig },
    success: HostRequirementsCheck,
    error: LinuxAppsError,
  }),
  /**
   * Install what is missing. The renderer names which requirements; the
   * commands are the main process's own, built from a fresh probe there.
   */
  Rpc.make("AppsInstall", {
    payload: {
      config: AppsConnectConfig,
      include: Schema.optionalKey(Schema.Array(RequirementId)),
    },
    success: AppsInstallEvent,
    error: LinuxAppsError,
    stream: true,
  }),
) {}
