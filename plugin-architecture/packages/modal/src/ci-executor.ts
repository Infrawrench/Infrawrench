/**
 * CI jobs on Modal: one Sandbox per job, in the workspace's default
 * environment, under an app named `infrawrench-ci`.
 *
 * **Wire shapes verified against `modal_proto/api.proto` and the JavaScript
 * SDK (`js/src/sandbox.ts`, `sandbox_impl_v1.ts`, `image.ts`,
 * `environment.ts`) in github.com/modal-labs/modal-client, main, November
 * 2026,** and the Sandbox guide and reference on modal.com/docs:
 * - `AppGetOrCreate(AppGetOrCreateRequest { app_name = 1; environment_name
 *   = 2; ObjectCreationType object_creation_type = 3; })` ->
 *   `{ app_id = 1; }`. `CREATE_IF_MISSING = 1` is the SDK's
 *   `App.lookup(name, create_if_missing=True)`, the deployed app named
 *   Sandboxes need; `UNSPECIFIED = 0` only looks it up (NOT_FOUND when absent).
 * - `EnvironmentGetOrCreate({ deployment_name = 1; })` -> `{ environment_id
 *   = 1; EnvironmentMetadata metadata = 2 { EnvironmentSettings settings = 2
 *   { image_builder_version = 1; } } }`: the builder version an image is
 *   built with, as the SDK reads it.
 * - `ImageGetOrCreate({ Image image = 2 { repeated string
 *   dockerfile_commands = 6; }; app_id = 4; builder_version = 9; })` ->
 *   `{ image_id = 1; GenericResult result = 2; }`, the SDK's
 *   `Image.fromRegistry(tag)` (`FROM <tag>`, no registry config for a public
 *   image). Without a `result` the build is still running:
 *   `ImageJoinStreaming({ image_id = 1; float timeout = 2; last_entry_id = 3;
 *   })` streams `{ GenericResult result = 1; entry_id = 3; }` until it is.
 * - `SandboxCreate({ app_id = 1; Sandbox definition = 2; repeated
 *   SandboxTag tags = 4; })` -> `{ sandbox_id = 1; }`. `Sandbox {
 *   repeated string entrypoint_args = 1; image_id = 3; Resources resources =
 *   5 { memory_mb = 2; milli_cpu = 3; GPUConfig gpu_config = 4 { count = 2;
 *   gpu_type = 4; } }; uint32 timeout_secs = 7; SchedulerPlacement
 *   scheduler_placement = 17 { repeated string regions = 4; }; NetworkAccess
 *   network_access = 22 { network_access_type = 1 (OPEN = 1) }; optional
 *   string name = 30; }`. A name in use by a running Sandbox answers
 *   ALREADY_EXISTS.
 * - `SandboxGetFromName({ sandbox_name = 1; environment_name = 2; app_name =
 *   3; bool include_terminated = 4; })` -> `{ sandbox_id = 1; }`, NOT_FOUND
 *   when there is none.
 * - `SandboxWait({ sandbox_id = 1; float timeout = 2; })` -> `{
 *   GenericResult result = 1; }`, a result only once it has finished;
 *   NOT_FOUND for an unknown id. `SandboxGetTaskId({ sandbox_id = 1;
 *   optional float timeout = 2; })` -> `{ optional string task_id = 1; }`
 *   once a container is scheduled.
 * - `SandboxTerminate({ sandbox_id = 1; })`, "a no-op if the Sandbox has
 *   already finished running".
 * - `SandboxList({ app_id = 1; double before_timestamp = 2; environment_name
 *   = 3; bool include_finished = 4; repeated SandboxTag tags = 5; })` -> `{
 *   repeated SandboxInfo sandboxes = 1 { id = 1; double created_at = 3;
 *   repeated SandboxTag tags = 6; name = 7; repeated string regions = 10; }
 *   }`, newest first, paged by `before_timestamp`. `SandboxTagsGet({
 *   sandbox_id = 1; })` -> `{ repeated SandboxTag tags = 1; }`; `SandboxTag {
 *   tag_name = 1; tag_value = 2; }`.
 *
 * Limits from the guide: a Sandbox lives at most 24 hours; a name is
 * letters, digits, `-`, `.` and `_`, under 64 characters, and unique among
 * an app's running Sandboxes; at most 10 tags and 512 bytes of tag keys and
 * values per Sandbox.
 *
 * **Backstop.** `timeout_secs` is the Sandbox's maximum lifetime: Modal
 * stops it then, whatever the host does. A finished Sandbox bills nothing.
 *
 * **No credentials in the Sandbox.** It gets no secrets, no volumes and no
 * OIDC identity token (`include_oidc_identity_token` stays false); the
 * Modal token only ever travels in the request headers.
 *
 * **Billing.** Per second, with no minimum stated; Sandboxes pay
 * non-preemptible CPU and memory rates (3x list), GPUs the standard rate,
 * and a named region costs 1.15x (broad) to 1.75x (narrow).
 */
import {
  ciBootstrapWithTools,
  ciComputeKey,
  ciGpuKey,
  parseCiContainerSize,
  parseCiGpu,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { ModalContext } from "./grpc.js";
import { GrpcCode, grpcCodeOf, serverStream, unary } from "./grpc.js";
import type { ProtoMessage } from "./proto.js";
import { ProtoWriter, decode } from "./proto.js";

/** The app every CI Sandbox runs under, made on first use in the default environment. */
export const CI_APP_NAME = "infrawrench-ci";
export const CI_DEFAULT_MACHINE = "2vcpu-4gb";
/** Ubuntu 24.04 with curl and CA certificates, from Docker Hub. */
export const CI_DEFAULT_IMAGE = "buildpack-deps:noble-curl";
/** A Sandbox's longest lifetime. */
export const CI_MAX_SECONDS = 24 * 60 * 60;

/** Modal's GPU names (modal.com/docs/guide/gpu), and how many of each one container may have. */
export const MODAL_GPUS: Readonly<Record<string, number>> = {
  T4: 8,
  L4: 8,
  A10: 4,
  L40S: 8,
  A100: 8,
  "A100-40GB": 8,
  "A100-80GB": 8,
  "RTX-PRO-6000": 8,
  H100: 8,
  "H100!": 8,
  H200: 8,
  B200: 8,
  "B200+": 8,
  B300: 8,
};

/** Region names Modal accepts (modal.com/docs/guide/region-selection). */
export const MODAL_REGIONS = [
  "us",
  "eu",
  "ap",
  "us-east",
  "us-central",
  "us-south",
  "us-west",
  "eu-west",
  "eu-north",
  "eu-south",
  "ap-northeast",
  "ap-southeast",
  "ap-south",
  "ap-melbourne",
  "jp",
  "au",
  "uk",
  "ca",
  "me",
  "sa",
  "af",
  "mx",
] as const;

export const MODAL_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Modal Sandbox",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE },
      // Not documented: a cached image starts in seconds, a new one is
      // pulled and converted first.
      typicalStartSeconds: 20,
      // Billed per second; Modal states no minimum.
      gpus: true,
      machineSuggestions: [
        "1vcpu-2gb",
        "2vcpu-4gb",
        "4vcpu-8gb",
        "8vcpu-16gb",
        "8vcpu-32gb",
        "16vcpu-64gb",
        "32vcpu-128gb",
      ],
    },
  ],
  helpLink: {
    label: "Give the token's user the Contributor role in the default environment",
    url: "https://modal.com/settings/workspace-management/environments",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  contributor: {
    permission: "Contributor",
    label: "Create the CI app and start, list and stop its Sandboxes",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** `ObjectCreationType`. */
const LOOKUP_ONLY = 0;
const CREATE_IF_MISSING = 1;
/** `GenericResult.GenericStatus`. */
const RESULT_STATUS: Readonly<Record<number, string>> = {
  1: "succeeded",
  2: "failed",
  3: "terminated",
  4: "timed out",
  5: "failed to start",
  6: "failed inside Modal",
  7: "stopped when idle",
  8: "evicted under memory pressure",
  9: "evicted for thrashing at its memory limit",
  10: "killed out of memory",
};
const SUCCESS = 1;
/** Rounds of `ImageJoinStreaming` (55 s each) a start waits for an image build. */
const IMAGE_WAIT_ROUNDS = 12;
const LIST_PAGE_LIMIT = 50;
const MAX_TAGS = 10;
const MAX_TAG_BYTES = 512;
/** The SDK's limit on a command line (`ARG_MAX`, 64 KiB). */
const MAX_COMMAND_BYTES = 64 * 1024;

async function rpc(ctx: ModalContext, method: string, req: ProtoWriter): Promise<ProtoMessage> {
  return decode(await unary(ctx, method, req.finish()));
}

function requireContainer(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Modal runs CI jobs of kind \`container\` (a Sandbox), not \`${kind}\`.`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The Sandbox's name: the same for every start of the same job. */
export function sandboxName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/**
 * `cloud.machine` (`<vCPUs>vcpu-<GB>gb`) as Modal resources. Modal counts
 * physical cores, each two vCPUs, so `2vcpu-4gb` asks for one core.
 */
export function sandboxResources(machine: string): { milliCpu: number; memoryMb: number } {
  const size = parseCiContainerSize(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Modal Sandbox is vCPUs and memory, like ${CI_DEFAULT_MACHINE}, not ${machine}.`,
    );
  }
  // A container has at least 0.125 physical cores.
  return {
    milliCpu: Math.max(125, Math.round(size.vcpus * 500)),
    memoryMb: Math.round(size.memoryGb * 1024),
  };
}

/** `cloud.gpu` (`type[:count]`) as Modal's GPU name and count. */
export function sandboxGpu(gpu: string): { type: string; count: number } {
  const request = parseCiGpu(gpu);
  const names = Object.keys(MODAL_GPUS);
  const wanted = request.type.toUpperCase();
  // Exact names first, so `H100!` and `B200+` keep their meaning.
  let type = names.find((n) => n === wanted);
  if (!type) {
    const key = ciGpuKey(request.type);
    // `A10G` is the A10's older name.
    type = key === "a10g" ? "A10" : names.find((n) => ciGpuKey(n) === key && !/[!+]$/.test(n));
  }
  if (!type) {
    throw new Error(
      `Modal has no GPU \`${request.type}\`. Name one of ${names.join(", ")}, e.g. \`H100\` or \`A100-80GB:2\`.`,
    );
  }
  const max = MODAL_GPUS[type] ?? 8;
  if (request.count > max) {
    throw new Error(`A Modal Sandbox has at most ${max} ${type} GPUs, not ${request.count}.`);
  }
  return { type, count: request.count };
}

function tagWriters(tags: Readonly<Record<string, string>>): ProtoWriter[] {
  return Object.entries(tags).map(([k, v]) => new ProtoWriter().string(1, k).string(2, v));
}

function checkTags(tags: Readonly<Record<string, string>>): void {
  const entries = Object.entries(tags);
  const bytes = entries.reduce(
    (n, [k, v]) => n + new TextEncoder().encode(k).length + new TextEncoder().encode(v).length,
    0,
  );
  if (entries.length > MAX_TAGS || bytes > MAX_TAG_BYTES) {
    throw new Error(
      `Modal keeps at most ${MAX_TAGS} tags and ${MAX_TAG_BYTES} bytes of tags on a Sandbox; this job has ${entries.length} tags and ${bytes} bytes.`,
    );
  }
}

/** The `SandboxCreate` request for a job. */
export function createRequest(spec: CiStartSpec, appId: string, imageId: string): ProtoWriter {
  const resources = sandboxResources(spec.machine ?? CI_DEFAULT_MACHINE);
  const gpu = spec.gpu ? sandboxGpu(spec.gpu) : undefined;
  const script = ciBootstrapWithTools(spec.bootstrap);
  if (new TextEncoder().encode(script).length > MAX_COMMAND_BYTES - 1024) {
    throw new Error("The job's bootstrap is too long for a Modal Sandbox's command line.");
  }
  const definition = new ProtoWriter()
    .strings(1, ["/bin/sh", "-c", script])
    .string(3, imageId)
    .message(
      5,
      new ProtoWriter()
        .int(2, resources.memoryMb)
        .int(3, resources.milliCpu)
        .message(4, gpu ? new ProtoWriter().int(2, gpu.count).string(4, gpu.type) : undefined),
    )
    .int(7, Math.min(CI_MAX_SECONDS, Math.max(60, Math.ceil(spec.maxSeconds))))
    .message(17, spec.region ? new ProtoWriter().strings(4, [spec.region]) : undefined)
    .message(22, new ProtoWriter().int(1, 1))
    .string(30, sandboxName(spec));
  const req = new ProtoWriter().string(1, appId).message(2, definition);
  for (const tag of tagWriters(spec.tags)) req.message(4, tag);
  return req;
}

/** The CI app's id, made if `create` and it is missing; null when only looking and it is not there. */
async function ciApp(ctx: ModalContext, create: boolean): Promise<string | null> {
  try {
    const res = await rpc(
      ctx,
      "AppGetOrCreate",
      new ProtoWriter().string(1, CI_APP_NAME).int(3, create ? CREATE_IF_MISSING : LOOKUP_ONLY),
    );
    return res.string(1) || null;
  } catch (err) {
    if (!create && grpcCodeOf(err) === GrpcCode.NOT_FOUND) return null;
    throw err;
  }
}

async function builderVersion(ctx: ModalContext): Promise<string> {
  const res = await rpc(ctx, "EnvironmentGetOrCreate", new ProtoWriter());
  return res.message(2)?.message(2)?.string(1) ?? "";
}

function resultText(result: ProtoMessage): string {
  const status = result.uint(1);
  const words = RESULT_STATUS[status] ?? `status ${status}`;
  const exception = result.string(2);
  return exception ? `${words}: ${exception}` : words;
}

/** Builds (or finds) the image for a registry tag and waits until it is ready. */
async function registryImage(ctx: ModalContext, appId: string, tag: string): Promise<string> {
  const res = await rpc(
    ctx,
    "ImageGetOrCreate",
    new ProtoWriter()
      .message(2, new ProtoWriter().strings(6, [`FROM ${tag}`]))
      .string(4, appId)
      .string(9, await builderVersion(ctx)),
  );
  const imageId = res.string(1);
  if (!imageId) throw new Error(`Modal made no image for ${tag}.`);
  let result = res.message(2);
  let lastEntry = "";
  for (let round = 0; !result?.uint(1) && round < IMAGE_WAIT_ROUNDS; round++) {
    const items = await serverStream(
      ctx,
      "ImageJoinStreaming",
      new ProtoWriter().string(1, imageId).float(2, 55).string(3, lastEntry).finish(),
    );
    for (const raw of items) {
      const item = decode(raw);
      if (item.string(3)) lastEntry = item.string(3);
      const done = item.message(1);
      if (done?.uint(1)) {
        result = done;
        break;
      }
    }
  }
  if (!result?.uint(1)) {
    throw new Error(`Modal is still preparing the image ${tag}; the job will start on a retry.`);
  }
  if (result.uint(1) !== SUCCESS) {
    throw new Error(`Modal could not prepare the image ${tag}: ${resultText(result)}`);
  }
  return imageId;
}

function handleOf(id: string, appId: string, name: string, region?: string): CiHandle {
  return {
    id,
    ...(region ? { region } : {}),
    label: `modal sandbox ${id}`,
    data: { app: appId, name },
  };
}

/** The job's Sandbox, running or finished, when a start already made it. */
async function findByName(ctx: ModalContext, name: string): Promise<string | null> {
  try {
    const res = await rpc(
      ctx,
      "SandboxGetFromName",
      new ProtoWriter().string(1, name).string(3, CI_APP_NAME).int(4, true),
    );
    return res.string(1) || null;
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Modal tokens cannot say what they may do, so this checks by using the
 * token: an environment lookup and a Sandbox list are reads, and getting
 * (or making) the empty `infrawrench-ci` app, which costs nothing and is
 * the first thing a start does anyway, is the one write. A user with the
 * Viewer role is refused that write.
 */
export async function modalCiPreflight(
  ctx: ModalContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireContainer(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  if (region && !(MODAL_REGIONS as readonly string[]).includes(region)) {
    problems.push(
      `Modal has no region \`${region}\`. Name one such as us, eu, ap, us-east or eu-west, or leave it out.`,
    );
  }
  try {
    await builderVersion(ctx);
  } catch (err) {
    problems.push(`Modal refused to read the default environment: ${message(err)}`);
    return { ok: false, missing, problems, ...(region ? { region } : {}) };
  }
  let appId: string | null = null;
  try {
    appId = await ciApp(ctx, true);
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.PERMISSION_DENIED) missing.push(CI_PERMISSIONS.contributor);
    else problems.push(`Modal refused to make the \`${CI_APP_NAME}\` app: ${message(err)}`);
  }
  if (appId) {
    try {
      await rpc(ctx, "SandboxList", new ProtoWriter().string(1, appId));
    } catch (err) {
      if (grpcCodeOf(err) === GrpcCode.PERMISSION_DENIED) {
        if (missing.length === 0) missing.push(CI_PERMISSIONS.contributor);
      } else {
        problems.push(`Modal refused to list Sandboxes: ${message(err)}`);
      }
    }
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    ...(region ? { region } : {}),
  };
}

export async function modalCiStart(ctx: ModalContext, spec: CiStartSpec): Promise<CiHandle> {
  requireContainer(spec.kind);
  if (spec.maxSeconds > CI_MAX_SECONDS) {
    throw new Error(
      `A Modal Sandbox runs at most 24 hours; this job may take ${Math.ceil(spec.maxSeconds / 60)} minutes.`,
    );
  }
  if (spec.region && !(MODAL_REGIONS as readonly string[]).includes(spec.region)) {
    throw new Error(`Modal has no region \`${spec.region}\`; name one such as us, eu or us-east.`);
  }
  checkTags(spec.tags);
  // Check what the job asked for before making anything.
  sandboxResources(spec.machine ?? CI_DEFAULT_MACHINE);
  if (spec.gpu) sandboxGpu(spec.gpu);
  const name = sandboxName(spec);
  const appId = await ciApp(ctx, true);
  if (!appId) throw new Error(`Modal gave no id for the \`${CI_APP_NAME}\` app.`);
  // The name makes a start idempotent: a retry finds the Sandbox the first made.
  const existing = await findByName(ctx, name);
  if (existing) return handleOf(existing, appId, name, spec.region);
  const imageId = await registryImage(ctx, appId, spec.image ?? CI_DEFAULT_IMAGE);
  try {
    const res = await rpc(ctx, "SandboxCreate", createRequest(spec, appId, imageId));
    const id = res.string(1);
    if (!id) throw new Error("Modal started no Sandbox.");
    return handleOf(id, appId, name, spec.region);
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.ALREADY_EXISTS) {
      const raced = await findByName(ctx, name);
      if (raced) return handleOf(raced, appId, name, spec.region);
    }
    throw err;
  }
}

export async function modalCiStatus(ctx: ModalContext, handle: CiHandle): Promise<CiComputeStatus> {
  let waited: ProtoMessage;
  try {
    waited = await rpc(ctx, "SandboxWait", new ProtoWriter().string(1, handle.id));
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.NOT_FOUND) return { state: "gone" };
    throw err;
  }
  const result = waited.message(1);
  if (result?.uint(1)) {
    const code = result.int(3);
    const detail = result.uint(1) === SUCCESS ? `exit code ${code}` : resultText(result);
    return { state: "stopped", detail };
  }
  try {
    const task = await rpc(
      ctx,
      "SandboxGetTaskId",
      new ProtoWriter().string(1, handle.id).float(2, 0, true),
    );
    return task.string(1) ? { state: "running" } : { state: "starting" };
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.DEADLINE_EXCEEDED) return { state: "starting" };
    throw err;
  }
}

export async function modalCiTeardown(ctx: ModalContext, handle: CiHandle): Promise<void> {
  try {
    await rpc(ctx, "SandboxTerminate", new ProtoWriter().string(1, handle.id));
  } catch (err) {
    if (grpcCodeOf(err) === GrpcCode.NOT_FOUND) return;
    throw err;
  }
}

function tagsFrom(entries: ProtoMessage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of entries) out[tag.string(1)] = tag.string(2);
  return out;
}

/**
 * Every running Sandbox of the CI app that carries `tagKey`. A finished
 * Sandbox bills nothing and is left out. Modal places Sandboxes itself, so
 * `regions` does not narrow it.
 */
export async function modalCiListTagged(
  ctx: ModalContext,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const appId = await ciApp(ctx, false);
  if (!appId) return [];
  const out: CiTaggedCompute[] = [];
  let before = 0;
  for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
    const res = await rpc(ctx, "SandboxList", new ProtoWriter().string(1, appId).double(2, before));
    const sandboxes = res.messages(1);
    if (sandboxes.length === 0) return out;
    for (const info of sandboxes) {
      const id = info.string(1);
      if (!id) continue;
      let tags = tagsFrom(info.messages(6));
      if (Object.keys(tags).length === 0) {
        try {
          tags = tagsFrom(
            (await rpc(ctx, "SandboxTagsGet", new ProtoWriter().string(1, id))).messages(1),
          );
        } catch (err) {
          if (grpcCodeOf(err) === GrpcCode.NOT_FOUND) continue;
          throw err;
        }
      }
      if (!(tagKey in tags)) continue;
      const created = info.double(3);
      out.push({
        handle: handleOf(id, appId, info.string(7), info.strings(10)[0]),
        tags,
        ...(created > 0 ? { createdAt: new Date(created * 1000).toISOString() } : {}),
        live: true,
      });
    }
    const last = sandboxes[sandboxes.length - 1]!.double(3);
    if (!(last > 0) || last === before) return out;
    before = last;
  }
  throw new Error(`Modal listed more than ${LIST_PAGE_LIMIT} pages of CI Sandboxes.`);
}
