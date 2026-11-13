/**
 * CI access: two capabilities a plugin can offer Infrawrench CI.
 *
 * - A **CI executor** (`manifest.ciExecutor`) can run one CI job on compute in
 *   the connected account: a fresh machine (`vm`), a one-off container
 *   (`container`), a managed build (`build`), an existing host (`host`) or a
 *   job on an existing cluster (`cluster`). The host owns everything about the
 *   job (which run, what it runs, its log, its result); the plugin only starts
 *   compute with an image, a size, a region, tags and a bootstrap script, says
 *   how it is doing, tears it down, and lists what it tagged. The bootstrap
 *   script is the same for every provider: it fetches the job from the host
 *   over HTTPS and reports back there, so the plugin never sees the job's
 *   secrets and the machine never gets the connection's credentials.
 * - A **CI credential** (`manifest.ciCredential`) can lend the connection to a
 *   job: files and environment variables a job writes before it runs (a
 *   kubeconfig, an SSH config entry and its key), minted short-lived wherever
 *   the provider allows. The host decides whether a job may have it (the
 *   organization's opt-in, the repository, the branch, a trusted run) and
 *   delivers it to the runner as secret parts, never in a plan or report.
 *
 * Nothing in the host knows a provider: the kinds, defaults, permissions and
 * the material all come from the plugin.
 */

/** Where a CI job runs, as a pipeline's `cloud.kind` names it. */
export const CI_EXECUTOR_KINDS = ["vm", "container", "build", "host", "cluster"] as const;

export type CiExecutorKind = (typeof CI_EXECUTOR_KINDS)[number];

/** One kind of compute a plugin can run a CI job on. */
export interface CiExecutorKindDeclaration {
  kind: CiExecutorKind;
  /** The provider's name for it, e.g. "EC2 instance", "Cloud Build". */
  label: string;
  /** Used when the pipeline leaves `machine`, `image` or `region` out. */
  defaults: {
    /** The provider's size name, e.g. `t3.large`. */
    machine?: string;
    /** A container image or OS image, in the provider's own terms. */
    image?: string;
    /** Omitted: the connection's own region. */
    region?: string;
  };
  /** Roughly how long until the job starts, for the UI. */
  typicalStartSeconds?: number;
  /** The shortest time the provider bills for, in seconds, when it bills by a period. */
  minimumBillingSeconds?: number;
  /** The kind can attach GPUs (`cloud.gpu`). */
  gpus?: boolean;
  /**
   * Machine names the UI offers as suggestions. Free text stays allowed: the
   * provider's own list is the authority, and a wrong name fails at start.
   */
  machineSuggestions?: readonly string[];
  /**
   * What `cloud.region` means for this kind, when it is not a region: a
   * Kubernetes or Nomad job reads it as the namespace. The UI and the docs
   * show this label beside it; omitted means "Region".
   */
  regionLabel?: string;
}

/** `manifest.ciExecutor`: the kinds of compute this plugin can run CI jobs on. */
export interface CiExecutorDeclaration {
  kinds: readonly CiExecutorKindDeclaration[];
  /** Where the user grants what {@link CiPreflightResult.missing} names. */
  helpLink?: { label: string; url: string };
}

/** One permission a connection lacks to run CI jobs of a kind. */
export interface CiMissingPermission {
  /** The provider's own permission string, e.g. `ec2:RunInstances`. */
  permission: string;
  /** What it is for, in a few words. */
  label: string;
}

/** Whether a connection can run CI jobs of a kind, checked without starting anything. */
export interface CiPreflightResult {
  ok: boolean;
  /** What the credential lacks. Empty when `ok`. */
  missing: CiMissingPermission[];
  /**
   * Anything else that stops it (no default network, a region turned off),
   * in a sentence the user can act on.
   */
  problems: string[];
  /** The region checked, when the provider has regions. */
  region?: string;
}

/** What the host asks a plugin to start for one CI job. */
export interface CiStartSpec {
  kind: CiExecutorKind;
  /** The provider's size name: the pipeline's, or the kind's default. */
  machine?: string;
  /** The pipeline's image, or the kind's default. */
  image?: string;
  /** The pipeline's region; omitted means the connection's own. */
  region?: string;
  /** `type[:count]`, when the pipeline asks for GPUs. */
  gpu?: string;
  /**
   * A POSIX shell script that runs the job and reports back to the host. Run
   * it as the first thing the compute does (user-data, a startup script, a
   * build step, a container command), as root where the kind allows. It
   * holds a per-job callback URL and token, nothing else secret; the job's
   * own secrets are fetched with it at run time.
   */
  bootstrap: string;
  /**
   * Put on everything the plugin creates for this job, where the provider has
   * tags or labels. Always includes {@link CI_TAG}; the plugin may rewrite
   * keys the provider cannot hold (lowercasing, `_` for `-`), as long as
   * `ciListTagged` gives them back as they were sent.
   */
  tags: Readonly<Record<string, string>>;
  /** A short name for the compute, where the provider shows one. */
  name: string;
  /**
   * The job's own timeout plus a margin. The compute should stop itself after
   * this long where the provider allows (an instance shutdown timer, a build
   * timeout), as a backstop to the host's teardown.
   */
  maxSeconds: number;
}

/**
 * What a plugin started, as the host keeps it. Opaque to the host apart from
 * `label`: the plugin puts whatever it needs to find the compute again in `id`
 * and `data`.
 */
export interface CiHandle {
  /** The provider's id for it (an instance id, a build id). */
  id: string;
  /** Where it is, when the provider has regions. */
  region?: string;
  /** Shown on the run page and the runner's report, e.g. `aws ec2 i-0abc`. */
  label: string;
  /** Anything else the plugin needs to tear it down. Not secret. */
  data?: Readonly<Record<string, string>>;
}

/** How a started job's compute is doing, as the provider reports it. */
export interface CiComputeStatus {
  /**
   * `starting`: not running the bootstrap yet. `running`: up. `stopped`: it
   * ended (the job may still be reporting its last lines). `gone`: the
   * provider no longer has it.
   */
  state: "starting" | "running" | "stopped" | "gone";
  /** The provider's own words, e.g. an instance state reason. */
  detail?: string;
}

/** Something a plugin finds tagged for CI. */
export interface CiTaggedCompute {
  handle: CiHandle;
  /** The tags it carries, as {@link CiStartSpec.tags} sent them. */
  tags: Readonly<Record<string, string>>;
  /** When the provider says it was created. */
  createdAt?: string;
  /** False once it has stopped and only lingers (a terminated instance). */
  live: boolean;
}

/** The tag every CI compute carries. Its value is the organization's CI scope. */
export const CI_TAG = "infrawrench-ci";
/** The run's id, on everything a CI job starts. */
export const CI_RUN_TAG = "infrawrench-ci-run";
/** The job's id in the host, on everything a CI job starts. */
export const CI_JOB_TAG = "infrawrench-ci-job";

/**
 * A value a plugin lends a job. A string is secret as a whole; a list of parts
 * shows its `text` parts and masks its `secret` parts, so the ordinary lines
 * of a kubeconfig or an SSH config are not masked in every log.
 */
export type CiLentValue = string | ReadonlyArray<{ text: string } | { secret: string }>;

/** A file a lent connection writes into the job's file system before it runs. */
export interface CiLentFile {
  /** Absolute, e.g. `/root/.kube/<alias>.yaml`. Never inside the job's clone. */
  path: string;
  /** Octal, default `600`. */
  mode?: string;
  content: CiLentValue;
}

/** What one connection lends a job. */
export interface CiLentMaterial {
  env: Readonly<Record<string, CiLentValue>>;
  files: readonly CiLentFile[];
  /** When the minted part stops working, if anything was minted. */
  expiresAt?: string;
  /** What was lent, in a few words for the audit log, e.g. "service account token, 40 minutes". */
  summary: string;
}

/** What the host asks a plugin to lend. */
export interface CiCredentialRequest {
  /** The connection's name, as the pipeline wrote it. */
  name: string;
  /**
   * A file-name-safe form of `name` (`[a-z0-9-]`), unique within the job.
   * Use it for file names and host aliases so two connections in one job
   * never write the same file.
   */
  alias: string;
  /** `connections: [{ name, namespace }]`: the namespace the job works in, where it means something. */
  namespace?: string;
  /** How long the job may run, in seconds: mint for at least this long. */
  ttlSeconds: number;
  /**
   * For each `accountReference` credential field whose referenced account
   * is also lent to this job: the alias that account was lent under. An SSH
   * host's "connect through" becomes `ProxyJump <alias>`.
   */
  references: Readonly<Record<string, string>>;
  /**
   * The SHA-256 host key fingerprint (`SHA256:...`) the organization pinned
   * for `host` and `port`, or null when none is pinned. For plugins that
   * write `known_hosts` checks.
   */
  pinnedHostKey(host: string, port: number): Promise<string | null>;
}

/** `manifest.ciCredential`: this plugin can lend a connection to a CI job. */
export interface CiCredentialDeclaration {
  /** What a job gets, e.g. "A kubeconfig for the cluster (`KUBECONFIG`)". */
  description: string;
  /** True when what it lends is minted per job and expires on its own. */
  shortLived: boolean;
  /** `connections: [{ name, namespace }]` means something to this plugin. */
  namespaces?: boolean;
}

/** `alias` for a name: lowercase letters, digits and `-`, never empty. */
export function ciAlias(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "connection";
}

/**
 * A short, stable key for one job's compute: lowercase hex, 32 characters,
 * the same for every call with the same job. Plugins use it for names that
 * make a start idempotent (an instance name, a resource group, a client
 * token) and fit every provider's naming rules. It comes from the
 * {@link CI_JOB_TAG} tag, or from the run and the name when that is absent.
 */
export function ciComputeKey(spec: Pick<CiStartSpec, "tags" | "name">): string {
  const job = spec.tags[CI_JOB_TAG];
  const plain = (job ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (job && plain.length >= 24 && plain.length === job.replace(/-/g, "").length) {
    return plain.slice(0, 32).padEnd(32, "0");
  }
  const source = job ?? `${spec.tags[CI_RUN_TAG] ?? ""}\u0000${spec.name}`;
  return fnv64(`a\u0000${source}`) + fnv64(`b\u0000${source}`);
}

/** FNV-1a, 64 bits, as 16 hex characters. Names, not security. */
function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** A container's size, for providers that size containers by vCPUs and memory. */
export interface CiContainerSize {
  vcpus: number;
  memoryGb: number;
}

/**
 * Reads `cloud.machine` for a container kind that has no size names of its
 * own: `<vCPUs>vcpu-<memory>gb`, e.g. `2vcpu-4gb` or `0.5vcpu-1gb` (`gib`
 * and a space or `/` in between are fine too). Null when it is not that.
 */
export function parseCiContainerSize(machine: string): CiContainerSize | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*vcpus?\s*[-_ /,]?\s*(\d+(?:\.\d+)?)\s*gi?b\s*$/i.exec(
    machine,
  );
  if (!match) return null;
  const vcpus = Number(match[1]);
  const memoryGb = Number(match[2]);
  if (!(vcpus > 0) || !(memoryGb > 0)) return null;
  return { vcpus, memoryGb };
}

/**
 * The argv that runs a job's bootstrap in a container that has no time limit
 * of its own: `/bin/sh -c <watchdog> iwci <bootstrap>`. The watchdog runs the
 * bootstrap, stops it once `maxSeconds` are up, and exits with its status, so
 * the container (whose main process it is) ends with the job or with its
 * time, whichever is first. Put the first two items where the provider takes
 * an entrypoint and the rest where it takes arguments.
 *
 * `exitZero` makes it exit 0 whatever the job did, for a provider that may
 * restart a container that exits otherwise: the job reports its result to
 * the host itself, and a restarted bootstrap must not run it again.
 */
export function ciContainerCommand(
  bootstrap: string,
  maxSeconds: number,
  options: { exitZero?: boolean } = {},
): string[] {
  const seconds = Math.max(60, Math.ceil(maxSeconds));
  const watchdog = [
    'sh -c "$1" &',
    "job=$!",
    `( sleep ${seconds}; echo "[infrawrench] the job ran out of time" >&2; kill -TERM "$job" 2>/dev/null; sleep 15; kill -KILL "$job" 2>/dev/null ) &`,
    "watchdog=$!",
    'wait "$job"',
    "status=$?",
    'kill "$watchdog" 2>/dev/null',
    options.exitZero ? "exit 0" : 'exit "$status"',
  ].join("\n");
  return ["/bin/sh", "-c", watchdog, "iwci", bootstrap];
}

/** A value quoted as one word for a POSIX shell. */
export function ciShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The bootstrap behind a preamble that installs what it needs (`bash`,
 * `curl`, `tar`, `gzip`, `base64`) with the image's package manager (apt,
 * apk, dnf, microdnf or yum) when the image lacks any, and fails naming
 * them when it cannot. For container kinds that run an image the pipeline
 * chose; pass the result to {@link ciContainerCommand}.
 */
export function ciBootstrapWithTools(bootstrap: string): string {
  return [
    "#!/bin/sh",
    "# Infrawrench CI: install what the job needs, then run it.",
    'need=""',
    'for t in bash curl tar gzip base64; do command -v "$t" >/dev/null 2>&1 || need="$need $t"; done',
    'if [ -n "$need" ]; then',
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bash curl ca-certificates tar gzip coreutils >/dev/null 2>&1",
    "  elif command -v apk >/dev/null 2>&1; then",
    "    apk add --no-cache bash curl ca-certificates tar gzip coreutils >/dev/null 2>&1",
    "  elif command -v dnf >/dev/null 2>&1; then",
    "    dnf install -y -q bash curl ca-certificates tar gzip coreutils >/dev/null 2>&1",
    "  elif command -v microdnf >/dev/null 2>&1; then",
    "    microdnf install -y bash curl ca-certificates tar gzip coreutils >/dev/null 2>&1",
    "  elif command -v yum >/dev/null 2>&1; then",
    "    yum install -y -q bash curl ca-certificates tar gzip coreutils >/dev/null 2>&1",
    "  fi",
    '  for t in $need; do command -v "$t" >/dev/null 2>&1 || { echo "Infrawrench CI: the image has no $t and it could not be installed" >&2; exit 127; }; done',
    "fi",
    bootstrap.replace(/^#![^\n]*\n/, ""),
  ].join("\n");
}
