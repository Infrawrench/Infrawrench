import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

/**
 * Linux application host setup.
 *
 * The application *session* is a WebSocket and deliberately absent from this
 * document — it carries a binary frame protocol, not JSON. These two routes are
 * the part a client can usefully hold: what a host is missing, and installing
 * it.
 */

const RequirementId = z
  .enum(["gzip", "xkb", "dbus", "fonts", "mesa", "icons"])
  .openapi("LinuxAppRequirementId", {
    description:
      "gzip unpacks the uploaded app server; xkb is the keyboard layout data xkbcommon " +
      "compiles a keymap from; dbus is the session bus GTK applications wait for; fonts, " +
      "mesa and icons decide what an application then looks like.",
  });

const AppsHostTarget = strict({
  accountId: z.string(),
  resourceId: z.string(),
  /** The org-managed SSH key. Its private half never leaves the server. */
  sshKeyId: z.string(),
  host: z.string(),
  username: z.string().max(64),
  port: z.number().int().min(1).max(65535).optional(),
}).openapi("LinuxAppHostTarget");

const RequirementStatus = strict({
  id: RequirementId,
  severity: z.enum(["required", "recommended"]),
  title: z.string(),
  summary: z.string(),
  ok: z.boolean(),
}).openapi("LinuxAppRequirement");

const HostPreflight = strict({
  arch: z.string(),
  osId: z.string(),
  osName: z.string(),
  packageManager: z.enum(["apt-get", "dnf", "yum", "apk", "pacman", "zypper"]).nullable(),
  privilege: z.enum(["root", "sudo", "sudo-password", "none"]),
  requirements: z.array(RequirementStatus),
  staging: z.boolean().openapi({
    description:
      "A writable, exec-capable directory was found to stage the app server in. False means " +
      "every candidate is missing, unwritable, or mounted noexec — which no package fixes.",
  }),
  appCount: z.number().int(),
  ready: z.boolean(),
}).openapi("LinuxAppHostPreflight");

const InstallPlan = strict({
  packageManager: z.enum(["apt-get", "dnf", "yum", "apk", "pacman", "zypper"]),
  privilege: z.enum(["root", "sudo", "sudo-password", "none"]),
  requirements: z.array(RequirementId),
  packages: z.array(z.string()),
  commands: z.array(z.string()).openapi({
    description: "Exactly what would run on the host, privilege prefix included.",
  }),
  canInstall: z.boolean(),
  blockedReason: z.string().optional(),
}).openapi("LinuxAppInstallPlan");

const HostRequirementsCheck = strict({
  preflight: HostPreflight,
  plan: InstallPlan.nullable(),
}).openapi("LinuxAppHostCheck");

const AppsSetupRequest = AppsHostTarget.extend({
  requirements: z.array(RequirementId).min(1).max(6).optional(),
}).openapi("LinuxAppSetupRequest");

export function registerAppsPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/apps/check",
    tags: ["Linux applications"],
    summary: "Check whether a host can run Linux applications",
    description:
      "Runs a read-only shell probe over SSH and reports what the host is missing, plus the " +
      "packages and commands that would fix it. A POST because it opens a connection to the " +
      "named host and must never be cached — its whole value is saying what the host is now.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AppsHostTarget } }, required: true },
    },
    responses: {
      200: {
        description: "What the host has, and what would fix it",
        content: { "application/json": { schema: HostRequirementsCheck } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "The host key is new or has changed; trust it and retry",
        content: { "application/json": { schema: z.object({ error: z.string() }).passthrough() } },
      },
      502: {
        description: "The host could not be reached or probed",
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/apps/setup",
    tags: ["Linux applications"],
    summary: "Install what a host needs to run Linux applications",
    description:
      "Installs the named requirements using the host's own package manager, then re-probes " +
      "and reports what the host now is. Takes requirement ids, never commands — the commands " +
      "are derived server-side from a fresh probe. Needs root or passwordless sudo on the " +
      "host, respects change freezes, and is audited as `linux_app.host_setup`.\n\n" +
      'Responds with `application/x-ndjson`: one `{"line":"…"}` per line of package-manager ' +
      'output, then a final `{"outcome":{…}}`. A failure arrives as `{"error":"…"}` inside ' +
      "the stream, because the status line has already been sent by then.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AppsSetupRequest } }, required: true },
    },
    responses: {
      200: {
        description: "A stream of output lines, then the outcome",
        content: {
          "application/x-ndjson": {
            schema: z
              .object({
                line: z.string().optional(),
                outcome: strict({
                  log: z.array(z.string()),
                  failed: z.array(z.string()),
                  preflight: HostPreflight,
                })
                  .optional()
                  .openapi("LinuxAppInstallOutcome"),
                error: z.string().optional(),
              })
              // Not strict: an `ssh_host_key_trust_required` error carries the
              // same fingerprint fields the 409 does, because a status line has
              // already gone out by the time this can happen.
              .passthrough()
              .openapi("LinuxAppSetupEvent"),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A change freeze is in effect, or the host key needs trusting",
        content: { "application/json": { schema: z.object({ error: z.string() }).passthrough() } },
      },
    },
  });
}
