/**
 * CI jobs on an SSH host the organization connected: the job runs on that
 * host, in a work directory of its own, as the connection's user.
 *
 * Unlike every other executor, nothing is created and nothing is torn down
 * but the job: the host is reused from job to job. So:
 * - **Start** makes `~/.infrawrench-ci/<job>` (the CI job's id, so a retry
 *   finds the job it started), writes the bootstrap and the tags there, and
 *   starts the bootstrap detached in a session of its own (`setsid`), with
 *   `HOME` and `TMPDIR` inside the work directory and `IWCI_WORK` naming it.
 * - **The backstop** is a watchdog in that session that kills the whole
 *   process group once the job's time is up; when the job ends on its own,
 *   whatever it left running in its group is killed too.
 * - **Teardown** kills every process that carries the job's `IWCI_WORK` in
 *   its environment (which a process that left the group still does), then
 *   the process group, and removes the work directory. It is idempotent: a
 *   job that is gone answers as removed.
 * - **Tags** are a file in the work directory; listing reads them back.
 *
 * Every step runs through the host's SSH service (`services.ssh`), which
 * connects the way its terminal does (pinned host key, jump hosts), so this
 * plugin never handles either. The job gets none of the connection's
 * credentials: it runs as the connection's user, but the private key never
 * reaches the host.
 */
import {
  CI_JOB_TAG,
  CI_TAG,
  ciComputeKey,
  ciShellQuote,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
  type SshHostServices,
} from "@infrawrench/plugin-base";

/** Where on the host the jobs' work directories are. */
const ROOT = '"${HOME:-/tmp}/.infrawrench-ci"';
/** What the bootstrap and the work directory need on the host. */
const TOOLS = ["setsid", "curl", "bash", "tar", "gzip", "base64", "mkdir", "kill"] as const;

export const SSH_CI_EXECUTOR = {
  kinds: [
    {
      kind: "host",
      label: "Existing SSH host",
      defaults: {},
      typicalStartSeconds: 5,
    },
  ],
  helpLink: {
    label: "Install what the host is missing, as the connection's user",
    url: "https://infrawrench.com/docs/plugins/ssh/#ci-jobs",
  },
} as const satisfies CiExecutorDeclaration;

function requireHost(kind: CiExecutorKind): void {
  if (kind !== "host") {
    throw new Error(`An SSH connection runs CI jobs of kind \`host\`, not \`${kind}\`.`);
  }
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** The work directory's name, from the CI job's id: the same id, the same directory. */
export function workName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `job-${ciComputeKey(spec)}`;
}

function checkName(name: string): string {
  if (!/^job-[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Not a CI work directory: ${name}`);
  return name;
}

/** Shell helpers every script shares: `W`, and whether a pid is this job's. */
function prelude(name: string): string[] {
  return [
    "set -u",
    "umask 077",
    `R=${ROOT}`,
    `W="$R/${checkName(name)}"`,
    // A process is the job's when its environment names the work directory
    // (Linux), or, without /proc, when its command line does.
    "ours() {",
    '  if [ -r "/proc/$1/environ" ]; then tr "\\000" "\\n" < "/proc/$1/environ" 2>/dev/null | grep -qxF "IWCI_WORK=$W";',
    '  else ps -o args= -p "$1" 2>/dev/null | grep -qF "$W"; fi',
    "}",
  ];
}

/** The script that starts a job. */
export function startScript(spec: CiStartSpec): string {
  const name = workName(spec);
  const seconds = Math.max(60, Math.ceil(spec.maxSeconds));
  // The session leader: runs the bootstrap, kills its whole group when the
  // time is up, and kills what the job left in its group when it ends.
  const session = [
    'sh "$IWCI_WORK/bootstrap.sh" & job=$!',
    '( sleep "$1"; echo timeout > "$IWCI_WORK/exit"; kill -KILL 0 ) &',
    'wait "$job"; echo "$?" > "$IWCI_WORK/exit"',
    "kill -KILL 0",
  ].join("\n");
  return [
    ...prelude(name),
    'need=""',
    `for t in ${TOOLS.join(" ")}; do command -v "$t" >/dev/null 2>&1 || need="$need $t"; done`,
    'if [ -n "$need" ]; then echo "IWCI_MISSING$need"; exit 0; fi',
    'if [ -d "$W" ]; then',
    // A retry after a lost answer: the job it already started.
    `  if [ "$(cat "$W/job" 2>/dev/null)" = ${ciShellQuote(spec.tags[CI_JOB_TAG] ?? spec.name)} ]; then echo "IWCI_STARTED $(cat "$W/pid" 2>/dev/null)"; exit 0; fi`,
    '  echo "IWCI_TAKEN"; exit 0',
    "fi",
    'mkdir -p "$W/home" "$W/tmp" || { echo "IWCI_NODIR"; exit 0; }',
    `printf %s ${ciShellQuote(b64(JSON.stringify(spec.tags)))} | base64 -d > "$W/tags"`,
    `printf %s ${ciShellQuote(spec.tags[CI_JOB_TAG] ?? spec.name)} > "$W/job"`,
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$W/created"',
    `printf %s ${ciShellQuote(b64(spec.bootstrap))} | base64 -d > "$W/bootstrap.sh"`,
    'cd "$W"',
    `IWCI_WORK="$W" HOME="$W/home" TMPDIR="$W/tmp" setsid sh -c ${ciShellQuote(session)} iwci ${seconds} "$W" > "$W/log" 2>&1 < /dev/null &`,
    'echo "$!" > "$W/pid"',
    'echo "IWCI_STARTED $!"',
    "",
  ].join("\n");
}

/** The script that reports how a job is doing. */
export function statusScript(name: string): string {
  return [
    ...prelude(name),
    'if [ ! -d "$W" ]; then echo "IWCI_STATE gone"; exit 0; fi',
    'if [ -f "$W/exit" ]; then echo "IWCI_STATE stopped $(cat "$W/exit")"; exit 0; fi',
    'P=$(cat "$W/pid" 2>/dev/null || true)',
    'if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && ours "$P"; then echo "IWCI_STATE running"; else echo "IWCI_STATE stopped"; fi',
    "",
  ].join("\n");
}

/** The script that ends a job and removes its work directory. */
export function teardownScript(name: string): string {
  return [
    ...prelude(name),
    'if [ ! -d "$W" ]; then echo "IWCI_REMOVED"; exit 0; fi',
    'P=$(cat "$W/pid" 2>/dev/null || true)',
    "kill_ours() {",
    '  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && ours "$P"; then kill "-$1" -- "-$P" 2>/dev/null || true; fi',
    "  if [ -d /proc ]; then",
    "    for d in /proc/[0-9]*; do",
    '      p=${d#/proc/}; [ "$p" = "$$" ] && continue',
    '      ours "$p" && kill "-$1" "$p" 2>/dev/null',
    "    done",
    "  fi",
    "  return 0",
    "}",
    "kill_ours TERM",
    "sleep 3",
    "kill_ours KILL",
    'rm -rf -- "$W"',
    'echo "IWCI_REMOVED"',
    "",
  ].join("\n");
}

/** The script that lists every job's work directory. */
export function listScript(): string {
  return [
    "set -u",
    `R=${ROOT}`,
    '[ -d "$R" ] || exit 0',
    'for W in "$R"/job-*; do',
    '  [ -d "$W" ] || continue',
    "  live=0",
    '  P=$(cat "$W/pid" 2>/dev/null || true)',
    '  if [ ! -f "$W/exit" ] && [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then live=1; fi',
    '  printf "IWCI_JOB %s %s %s %s\\n" "${W##*/}" "$live" "$(cat "$W/created" 2>/dev/null || echo -)" "$(base64 < "$W/tags" 2>/dev/null | tr -d "\\n" || true)"',
    "done",
    "",
  ].join("\n");
}

/** The script that checks the host can run jobs. */
export function preflightScript(): string {
  return [
    "set -u",
    `R=${ROOT}`,
    'echo "IWCI_OS $(uname -s 2>/dev/null || echo unknown)"',
    `for t in ${TOOLS.join(" ")}; do command -v "$t" >/dev/null 2>&1 || echo "IWCI_NO $t"; done`,
    'if mkdir -p "$R" 2>/dev/null && [ -w "$R" ]; then echo "IWCI_WRITABLE"; fi',
    "",
  ].join("\n");
}

/** What to install for a missing tool, by name. */
const INSTALL: Record<string, string> = {
  setsid: "util-linux (apt-get install util-linux, or apk add util-linux)",
  curl: "curl",
  bash: "bash",
  tar: "tar",
  gzip: "gzip",
  base64: "coreutils",
  mkdir: "coreutils",
  kill: "procps or coreutils",
};

function lines(output: string, prefix: string): string[][] {
  return output
    .split("\n")
    .filter((l) => l.startsWith(`${prefix} `) || l === prefix)
    .map((l) => l.split(" ").slice(1));
}

function handleOf(name: string, host: string): CiHandle {
  return { id: name, label: `ssh ${host} ${name}`, data: { name } };
}

function nameOf(handle: CiHandle): string {
  return checkName(handle.data?.["name"] ?? handle.id);
}

function noSsh(): Error {
  return new Error(
    "This Infrawrench host cannot open SSH sessions for plugins yet, so it cannot run CI jobs on an SSH host.",
  );
}

export async function ciPreflight(
  ssh: SshHostServices | undefined,
  kind: CiExecutorKind,
): Promise<CiPreflightResult> {
  requireHost(kind);
  if (!ssh) return { ok: false, missing: [], problems: [noSsh().message] };
  const problems: string[] = [];
  let output: string;
  try {
    output = await ssh.exec(preflightScript(), { timeoutMs: 30_000 });
  } catch (err) {
    return {
      ok: false,
      missing: [],
      problems: [
        `Infrawrench could not run a command on the host: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const os = lines(output, "IWCI_OS")[0]?.[0] ?? "unknown";
  if (os !== "Linux") {
    problems.push(`The host runs ${os}; CI jobs need a Linux host.`);
  }
  for (const [tool = ""] of lines(output, "IWCI_NO")) {
    problems.push(`The host has no ${tool}. Install ${INSTALL[tool] ?? tool}.`);
  }
  if (lines(output, "IWCI_WRITABLE").length === 0) {
    problems.push(
      "The connection's user cannot write its home directory, where each job gets a work directory (~/.infrawrench-ci).",
    );
  }
  // Access is the connection's user's own: there are no permissions to name.
  return { ok: problems.length === 0, missing: [], problems };
}

export async function ciStart(
  ssh: SshHostServices | undefined,
  host: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireHost(spec.kind);
  if (!ssh) throw noSsh();
  if (spec.machine || spec.image || spec.gpu) {
    throw new Error(
      "A job on an SSH host runs on the host as it is: leave `cloud.machine`, `cloud.image` and `cloud.gpu` out.",
    );
  }
  const name = workName(spec);
  let output: string;
  try {
    output = await ssh.exec(startScript(spec), { timeoutMs: 60_000 });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new Error(`The host refused the job: ${text}`, { cause: err });
  }
  const missing = lines(output, "IWCI_MISSING")[0];
  if (missing) throw new Error(`The host has no ${missing.join(", ")}.`);
  if (lines(output, "IWCI_TAKEN").length > 0) {
    throw new Error(`A work directory ${name} on the host belongs to another job.`);
  }
  if (lines(output, "IWCI_STARTED").length === 0) {
    throw new Error(`The host did not start the job: ${output.trim().slice(0, 500)}`);
  }
  return handleOf(name, host);
}

export async function ciStatus(
  ssh: SshHostServices | undefined,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  if (!ssh) throw noSsh();
  const output = await ssh.exec(statusScript(nameOf(handle)), { timeoutMs: 30_000 });
  const [state = "", detail] = lines(output, "IWCI_STATE")[0] ?? [];
  if (state === "gone") return { state: "gone" };
  if (state === "running") return { state: "running" };
  if (state === "stopped") {
    const text = detail === "timeout" ? "timed out" : detail ? `exit code ${detail}` : "";
    return text ? { state: "stopped", detail: text } : { state: "stopped" };
  }
  throw new Error(`The host gave no state for the job: ${output.trim().slice(0, 500)}`);
}

export async function ciTeardown(
  ssh: SshHostServices | undefined,
  handle: CiHandle,
): Promise<void> {
  if (!ssh) throw noSsh();
  const output = await ssh.exec(teardownScript(nameOf(handle)), { timeoutMs: 60_000 });
  if (lines(output, "IWCI_REMOVED").length === 0) {
    throw new Error(`The host did not confirm the job was removed: ${output.trim().slice(0, 500)}`);
  }
}

export async function ciListTagged(
  ssh: SshHostServices | undefined,
  host: string,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  if (!ssh) throw noSsh();
  const output = await ssh.exec(listScript(), { timeoutMs: 60_000 });
  const out: CiTaggedCompute[] = [];
  for (const [name = "", live = "0", created = "-", encoded = ""] of lines(output, "IWCI_JOB")) {
    if (!/^job-[A-Za-z0-9._-]+$/.test(name)) continue;
    let tags: Record<string, string> = {};
    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        tags = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    } catch {
      // A directory without readable tags is still a CI job's: it is under the CI root.
      tags = { [CI_TAG]: "" };
    }
    if (tagKey !== CI_TAG && tags[tagKey] === undefined) continue;
    out.push({
      handle: handleOf(name, host),
      tags,
      ...(created !== "-" ? { createdAt: created } : {}),
      live: live === "1",
    });
  }
  return out;
}
