/**
 * Linux application host setup: `/api/org/:orgId/apps`, the endpoint
 * definitions. What a host is missing to run Linux applications, and
 * installing it.
 *
 * The application *session* is a WebSocket (`/api/apps`, upgraded in
 * `server.ts`) and deliberately absent: it carries a binary frame protocol.
 * The bodies are the validators the routes always applied (strict, refused
 * with the first issue's sentence), so both endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";
import { describeResponse } from "../http/schemas/documented";
import { ChangeFreezeBlocked } from "../http/schemas/change-freeze";
import { SshHostKeyTrustRequired } from "../http/schemas/ssh-host-key-trust";

export const LINUX_APP_REQUIREMENT_IDS = ["gzip", "xkb", "dbus", "fonts", "mesa", "icons"] as const;

const RequirementId = Schema.Literals(LINUX_APP_REQUIREMENT_IDS).annotate({
  identifier: "LinuxAppRequirementId",
  description:
    "gzip unpacks the uploaded app server; xkb is the keyboard layout data xkbcommon " +
    "compiles a keymap from; dbus is the session bus GTK applications wait for; fonts, " +
    "mesa and icons decide what an application then looks like.",
});

const NonEmpty = Schema.String.check(minLength(1));

/**
 * The destination, named exactly as the WebSocket names it: an account, a
 * resource, the org's key, and the address the resource reported. The host
 * goes through `resolveSafeHost` before anything is dialled.
 */
const hostTargetFields = {
  accountId: NonEmpty,
  resourceId: NonEmpty,
  /** The org-managed SSH key. Its private half never leaves the server. */
  sshKeyId: NonEmpty,
  host: NonEmpty,
  username: Schema.String.check(minLength(1), maxLength(64)),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
};

export const LinuxAppHostTarget = Schema.Struct(hostTargetFields).annotate({
  identifier: "LinuxAppHostTarget",
});

export const LinuxAppSetupRequest = Schema.Struct({
  ...hostTargetFields,
  /**
   * Which requirements to satisfy. Omitted means every missing required one:
   * the "install everything needed" case, which is what the button does.
   */
  requirements: Schema.optionalKey(
    Schema.Array(RequirementId).check(minLength(1), maxLength(LINUX_APP_REQUIREMENT_IDS.length)),
  ),
}).annotate({ identifier: "LinuxAppSetupRequest" });

const PackageManager = Schema.Literals(["apt-get", "dnf", "yum", "apk", "pacman", "zypper"]);
const Privilege = Schema.Literals(["root", "sudo", "sudo-password", "none"]);

const LinuxAppRequirement = Schema.Struct({
  id: RequirementId,
  severity: Schema.Literals(["required", "recommended"]),
  title: Schema.String,
  summary: Schema.String,
  ok: Schema.Boolean,
}).annotate({ identifier: "LinuxAppRequirement" });

const LinuxAppHostPreflight = Schema.Struct({
  arch: Schema.String,
  osId: Schema.String,
  osName: Schema.String,
  packageManager: Schema.NullOr(PackageManager),
  privilege: Privilege,
  requirements: Schema.Array(LinuxAppRequirement),
  staging: Schema.Boolean.annotate({
    description:
      "A writable, exec-capable directory was found to stage the app server in. False means " +
      "every candidate is missing, unwritable, or mounted noexec, which no package fixes.",
  }),
  appCount: Schema.Int,
  ready: Schema.Boolean,
}).annotate({ identifier: "LinuxAppHostPreflight" });

const LinuxAppInstallPlan = Schema.Struct({
  packageManager: PackageManager,
  privilege: Privilege,
  requirements: Schema.Array(RequirementId),
  packages: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String).annotate({
    description: "Exactly what would run on the host, privilege prefix included.",
  }),
  canInstall: Schema.Boolean,
  blockedReason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LinuxAppInstallPlan" });

export const LinuxAppHostCheck = Schema.Struct({
  preflight: LinuxAppHostPreflight,
  plan: Schema.NullOr(LinuxAppInstallPlan),
}).annotate({ identifier: "LinuxAppHostCheck" });

const LinuxAppInstallOutcome = Schema.Struct({
  log: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  preflight: LinuxAppHostPreflight,
}).annotate({ identifier: "LinuxAppInstallOutcome" });

/**
 * One line of the setup stream. Open: an `ssh_host_key_trust_required` error
 * carries the same fingerprint fields the 409 does, because the status line
 * has already gone out by the time it can happen.
 */
const LinuxAppSetupEvent = Schema.StructWithRest(
  Schema.Struct({
    line: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(LinuxAppInstallOutcome),
    error: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).annotate({ identifier: "LinuxAppSetupEvent" });

export class LinuxAppsGroup extends HttpApiGroup.make("linuxApps")
  .add(
    HttpApiEndpoint.post("check", "/check", {
      params: OrgParams,
      payload: LinuxAppHostTarget,
      success: LinuxAppHostCheck,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired, BadGateway],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Check whether a host can run Linux applications")
      .annotate(
        OpenApi.Description,
        "Runs a read-only shell probe over SSH and reports what the host is missing, plus the " +
          "packages and commands that would fix it. A POST because it opens a connection to the " +
          "named host and must never be cached; its whole value is saying what the host is now.",
      )
      .annotate(OpenApi.Transform, describeResponse(502, "The host could not be reached or probed"))
      .annotate(SuccessDescription, "What the host has, and what would fix it"),
    HttpApiEndpoint.post("setup", "/setup", {
      params: OrgParams,
      payload: LinuxAppSetupRequest,
      success: HttpApiSchema.StreamNdjson({ schema: LinuxAppSetupEvent }),
      error: [BadRequest, NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Install what a host needs to run Linux applications")
      .annotate(
        OpenApi.Description,
        "Installs the named requirements using the host's own package manager, then re-probes " +
          "and reports what the host now is. Takes requirement ids, never commands; the commands " +
          "are derived server-side from a fresh probe. Needs root or passwordless sudo on the " +
          "host, respects change freezes, and is audited as `linux_app.host_setup`.\n\n" +
          'Responds with `application/x-ndjson`: one `{"line":"…"}` per line of package-manager ' +
          'output, then a final `{"outcome":{…}}`. A failure arrives as `{"error":"…"}` inside ' +
          "the stream, because the status line has already been sent by then.",
      )
      .annotate(SuccessDescription, "A stream of output lines, then the outcome"),
  )
  .prefix("/api/org/:orgId/apps")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Linux applications") {}

export class LinuxAppsApi extends withApiDefaults(HttpApi.make("linux-apps").add(LinuxAppsGroup)) {}
