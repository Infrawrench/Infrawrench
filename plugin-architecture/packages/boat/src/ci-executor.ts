/**
 * CI jobs on boat: one fresh sandbox per job, deleted when the job ends.
 *
 * **Kind.** A boat sandbox is a whole Ubuntu virtual machine with its own
 * kernel, root through passwordless `sudo`, and Docker: a fresh machine, so
 * the kind is `vm`. `cloud.image` names a saved snapshot (or a share code) to
 * start from instead of boat's base image.
 *
 * **Wire shapes verified against boat's Public API v1 document
 * (`docs.boat.dev/openapi/boat-v1.yaml`, the one `plugingen.json` names) and
 * docs (`docs.boat.dev/api-keys/scopes.md`, `security.md`, `pricing.md`),
 * November 2026:**
 * - `POST /sandboxes` with `Idempotency-Key` (kept 24 hours; the same key and
 *   body give back the same sandbox, another body answers 409
 *   `idempotency_key_reused`): `name`, `type` (`small`, `default`, `large`,
 *   `xlarge`), `ttlSeconds` (auto-stop, 1 to 2592000, from create), `labels`
 *   (at most 20, keys `[A-Za-z0-9][A-Za-z0-9._/-]{0,62}`, values up to 256
 *   bytes), `noEnv`, `snapshots`, `monitoring`, `visibility`, `files`
 *   (written before the sandbox is `ready`, 256 KB in all), `setupScript`
 *   (runs once it is ready, as `user` through bash, in the background),
 *   `from` (a saved snapshot).
 * - `GET /sandboxes?name=&namePrefix=&label=k=v&cursor=` and `GET
 *   /sandboxes/{id}`; states `init`, `provisioning`, `provisioned`,
 *   `cloning`, `ready`, `idle`, `running`, `archiving`, `archived` (stopped),
 *   `error`, `cancelled` (then 404).
 * - `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete: <id>`: 202, the
 *   machine and its data go in the background; 404 when it is gone.
 * - Billing: per second while a sandbox runs; a stopped sandbox costs no
 *   machine time. Every create counts as a start against the plan's start
 *   limits, and starts past them are charged.
 *
 * **No credentials in the sandbox.** `noEnv` gives it none of the account's
 * secrets, environment variables, git or AI logins, and removes the
 * in-sandbox boat API key; what stays is `ASCII_TOKEN`, which can only host
 * ports of its own sandbox. It is `private`, so organization members cannot
 * open it, keeps no command output at boat (`monitoring: false`) and takes no
 * snapshots (`snapshots: false`), so a stop erases its disk.
 *
 * **Backstop.** `ttlSeconds` stops the sandbox at the job's deadline, which
 * ends the billing and, with snapshots off, erases its disk; the bootstrap
 * runs under `timeout` with the same deadline. The stopped sandbox's record
 * stays until the host's teardown or reaper deletes it.
 *
 * **Preflight.** A scoped key cannot list its own actions, so the check
 * reads (`sandbox.read`) and sends a delete for a sandbox id that cannot
 * exist (`api_key_action_forbidden` means no delete action). Whether it may
 * create shows only at the first start; the `ci` preset has all three.
 */
import {
  CI_JOB_TAG,
  ciComputeKey,
  ciHttpStatus,
  ciMachineName,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
  pathEncode,
  withCursorPagination,
} from "@infrawrench/plugin-base";

import { BoatApiError, type BoatApi } from "./api.js";
import type { BSandbox, BSandboxType } from "./types.js";
import { SIZES } from "./sizes.js";

export const CI_DEFAULT_MACHINE = "default";
/** Where the bootstrap is written before the sandbox is ready. */
export const BOOTSTRAP_PATH = "/tmp/iwci-bootstrap.sh";
/** boat's longest auto-stop. */
const MAX_TTL_SECONDS = 2_592_000;

export const BOAT_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "boat sandbox",
      defaults: { machine: CI_DEFAULT_MACHINE },
      // Not documented; a sandbox is usually ready within seconds.
      typicalStartSeconds: 15,
      // Billed per second while it runs, no minimum documented.
      machineSuggestions: SIZES.map((s) => s.id),
    },
  ],
  helpLink: {
    label: "Make a boat API key with the ci preset",
    url: "https://docs.boat.dev/api-keys/scopes",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  read: { permission: "sandbox.read", label: "Follow the job's sandbox and find leftovers" },
  delete: {
    permission: "sandbox.delete-own",
    label: "Delete the job's sandbox when it ends (or sandbox.delete)",
  },
  create: { permission: "sandbox.create", label: "Start the job's sandbox" },
} as const satisfies Record<string, CiMissingPermission>;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`boat runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

function typeOf(machine: string): BSandboxType {
  const size = SIZES.find((s) => s.id === machine.trim());
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a boat sandbox is one of ${SIZES.map((s) => s.id).join(", ")}, not ${machine}.`,
    );
  }
  return size.id;
}

/** The script boat runs once the sandbox is ready: the bootstrap as root, until the deadline. */
export function setupScript(maxSeconds: number): string {
  const seconds = Math.max(60, Math.ceil(maxSeconds));
  return [
    "#!/bin/bash",
    "# Infrawrench CI: run the job as root, stopped at its deadline.",
    `exec sudo -n timeout -k 15 ${seconds} bash ${BOOTSTRAP_PATH}`,
    "",
  ].join("\n");
}

/** The create body for a job. */
export function createBody(spec: CiStartSpec) {
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(60, Math.ceil(spec.maxSeconds)));
  return {
    name: ciMachineName(spec),
    type: typeOf(spec.machine ?? CI_DEFAULT_MACHINE),
    ttlSeconds: ttl,
    labels: { ...spec.tags },
    noEnv: true,
    snapshots: false,
    monitoring: false,
    visibility: "private" as const,
    files: [{ path: BOOTSTRAP_PATH, content: spec.bootstrap, encoding: "utf8" as const }],
    setupScript: setupScript(spec.maxSeconds),
    ...(spec.image ? { from: spec.image } : {}),
  };
}

function handleOf(sandbox: Pick<BSandbox, "id">): CiHandle {
  return { id: sandbox.id, label: `boat sandbox ${sandbox.id}` };
}

function errorCode(err: unknown): string {
  return err instanceof BoatApiError ? err.code : "";
}

export async function boatCiPreflight(
  api: BoatApi,
  kind: CiExecutorKind,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  try {
    await api.get("/sandboxes", { query: { limit: 1, namePrefix: "iwci-" } });
  } catch (err) {
    if (ciHttpStatus(err) === 403) missing.push(CI_PERMISSIONS.read);
    else problems.push(`boat refused a read: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // An id of the right shape that cannot exist: the action is checked first.
    await api.delete(`/sandboxes/${pathEncode("bx_22222222")}`, {
      headers: { "X-Ascii-Confirm-Delete": "bx_22222222" },
    });
  } catch (err) {
    if (errorCode(err) === "api_key_action_forbidden") missing.push(CI_PERMISSIONS.delete);
  }
  try {
    const limits = await api.get("/limits");
    if (limits && limits.canStart === false) {
      problems.push(
        `boat will not start sandboxes on this account now${limits.startBlockedReason ? `: ${limits.startBlockedReason}` : ""}. Check the plan and wallet in the boat dashboard.`,
      );
    }
  } catch {
    // A ci key may not read the account; the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems };
}

async function findSandbox(api: BoatApi, spec: CiStartSpec): Promise<BSandbox | undefined> {
  const job = spec.tags[CI_JOB_TAG];
  const res = await api.get("/sandboxes", {
    query: {
      name: ciMachineName(spec),
      ...(job ? { label: [`${CI_JOB_TAG}=${job}`] } : {}),
    },
  });
  return (res?.sandboxes ?? []).find((s) => s.state !== "cancelled");
}

export async function boatCiStart(api: BoatApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) throw new Error("boat sandboxes have no GPUs; leave `cloud.gpu` out.");
  const body = createBody(spec);
  // The job's name and label make a start idempotent: a retry finds what the first made.
  const found = await findSandbox(api, spec);
  if (found) return handleOf(found);
  try {
    const res = await api.post("/sandboxes", {
      body,
      // A lost answer retried with the same key and body gives back the same sandbox.
      headers: { "Idempotency-Key": `iwci-${ciComputeKey(spec)}` },
    });
    if (!res?.sandbox) throw new Error("boat started no sandbox");
    return handleOf(res.sandbox);
  } catch (err) {
    if (ciHttpStatus(err) === 409) {
      const raced = await findSandbox(api, spec);
      if (raced) return handleOf(raced);
    }
    throw err;
  }
}

const STARTING = new Set(["init", "provisioning", "provisioned", "cloning"]);
const RUNNING = new Set(["ready", "idle", "running"]);

export async function boatCiStatus(api: BoatApi, handle: CiHandle): Promise<CiComputeStatus> {
  let sandbox: BSandbox | undefined;
  try {
    sandbox = (await api.get(`/sandboxes/${pathEncode(handle.id)}`))?.sandbox;
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (!sandbox) return { state: "gone" };
  const status = sandbox.state;
  const state: CiComputeStatus["state"] = STARTING.has(status)
    ? "starting"
    : RUNNING.has(status)
      ? "running"
      : status === "cancelled"
        ? "gone"
        : "stopped";
  const detail = [status, sandbox.error].filter(Boolean).join(": ");
  return detail ? { state, detail } : { state };
}

export async function boatCiTeardown(api: BoatApi, handle: CiHandle): Promise<void> {
  try {
    // boat refuses a delete unless the header repeats the id.
    await api.delete(`/sandboxes/${pathEncode(handle.id)}`, {
      headers: { "X-Ascii-Confirm-Delete": handle.id },
    });
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every `iwci-` sandbox carrying the tag. boat has no regions. */
export async function boatCiListTagged(api: BoatApi, tagKey: string): Promise<CiTaggedCompute[]> {
  const sandboxes = (await withCursorPagination(api, {
    cursorParam: "cursor",
    sizeParam: "limit",
    pageSize: 200,
    next: "pageInfo.nextCursor",
    hasMore: "pageInfo.hasMore",
    maxPages: 100,
  }).getAll("/sandboxes", "sandboxes", { query: { namePrefix: "iwci-" } })) as BSandbox[];
  return sandboxes.flatMap((s) => {
    const labels = s.labels ?? {};
    if (labels[tagKey] === undefined || s.state === "cancelled") return [];
    return [
      {
        handle: handleOf(s),
        tags: { ...labels },
        ...(s.createdAt ? { createdAt: s.createdAt } : {}),
        live: STARTING.has(s.state) || RUNNING.has(s.state),
      },
    ];
  });
}
