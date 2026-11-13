/**
 * The scripts that run a cloud job on a machine, the same for every provider.
 *
 * - The **bootstrap** is what the plugin starts the machine with (EC2 user
 *   data, a startup script, a build step). It holds the job's callback URL,
 *   whose path carries a per-job random token, and nothing else secret. It
 *   fetches the job script once, with that token, and runs it.
 * - The **job script** is served once to the machine by the callback
 *   (`GET /api/ci-jobs/script`, the token in a header) and holds the job's secrets (its
 *   environment and lent files), so it is never in user data, a log or the
 *   database. It fetches the commit (a GitHub source archive, through the
 *   callback, which redirects to a short-lived link), the artifacts of the
 *   jobs it needs (from the CI proxy, with the claim's token), runs `run:`
 *   with `set -euo pipefail` in `cwd` under the job's timeout, streams its
 *   output and a heartbeat back to the callback (which relays them to the
 *   runner, which masks them), uploads its artifacts, and reports how it
 *   ended with `$IWCI_OUTPUT` and, for `changes: fail`, what changed.
 *
 * Needs `bash`, `curl`, `tar`, `gzip`, `base64` and coreutils on the image;
 * `git` only for `changes: fail`. A source archive has no history, so a job
 * that reads git history needs it fetched in its own script.
 */

/** A value quoted for a POSIX shell, as one word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** The machine's start-up script. */
/** The header a machine sends its per-job token in: never in a URL, so never in a request log. */
export const CI_JOB_TOKEN_HEADER = "X-Infrawrench-Ci-Job";

export function bootstrapScript(callbackUrl: string, token: string): string {
  return [
    "#!/bin/sh",
    "# Infrawrench CI: fetch this job from Infrawrench and run it.",
    "umask 077",
    `IWCI_CB=${shq(callbackUrl)}`,
    `IWCI_TOKEN=${shq(token)}`,
    "i=0",
    // Its own file: a reused host may run several jobs at once.
    'F=$(mktemp "${TMPDIR:-/tmp}/iwci-job.XXXXXX") || exit 1',
    'while [ "$i" -lt 30 ]; do',
    `  if curl -fsS -m 60 -H "${CI_JOB_TOKEN_HEADER}: $IWCI_TOKEN" -o "$F" "$IWCI_CB/script"; then exec bash "$F"; fi`,
    "  i=$((i + 1))",
    "  sleep 10",
    "done",
    "exit 1",
    "",
  ].join("\n");
}

/** What the job script is built from: the claim's spec and its secret part. */
export interface JobScriptInput {
  callbackUrl: string;
  /** The per-job token, sent in {@link CI_JOB_TOKEN_HEADER}. */
  token: string;
  proxyUrl: string;
  name: string;
  script: string;
  cwd: string;
  cloneInto: string | null;
  timeoutSecs: number;
  changes: "ignore" | "fail";
  env: Record<string, string>;
  files: Array<{ path: string; mode?: string; content: string }>;
  /** Proxy-relative, with the claim's token in it. */
  inputsUrl: string | null;
  artifacts: { url: string; paths: string[] } | null;
  /**
   * The compute is not fresh (a reused host): run the job in a root of its
   * own, so two jobs on one host never collide, a user other than root
   * works, and nothing of the host's own is overwritten. The clone and other
   * absolute paths land under the root, and lent files and values under
   * `/root` land under `HOME`. When the executor has prepared a work
   * directory (`IWCI_WORK`, with `HOME` and `TMPDIR` inside it, as the SSH
   * host executor does), the root is inside it; otherwise it is a temporary
   * directory with `HOME` inside it. The root goes before the result is
   * reported; the executor's own work directory is the executor's to remove.
   * Absolute paths the job's own script writes are its business.
   */
  isolate?: boolean;
}

/** Stand for the job's root and `HOME` in values, filled in on the machine. */
const ROOT = "@@IWCI_ROOT@@";
const HOME = "@@IWCI_HOME@@";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODE = /^[0-7]{3,4}$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The script the callback serves the machine. Holds secrets: never log it. */
export function jobScript(input: JobScriptInput): string {
  const isolate = input.isolate === true;
  const underRoot = (path: string) => path === "/root" || path.startsWith("/root/");
  // An absolute path as the job sees it: as written on fresh compute; on a
  // reused host under `HOME` (for `/root/...`) or under the job's root.
  const at = (path: string) =>
    !isolate
      ? shq(path)
      : underRoot(path)
        ? `"$HOME"${shq(path.slice("/root".length))}`
        : `"$R"${shq(path)}`;
  // A value with those paths marked, so the machine puts its own in place.
  const moves: Array<[string, string]> = [
    ["/root", HOME],
    ...(input.cloneInto && input.cloneInto !== "/"
      ? ([[input.cloneInto, `${ROOT}${input.cloneInto}`]] as Array<[string, string]>)
      : []),
  ];
  const rooted = (value: string) =>
    !isolate
      ? value
      : moves.reduce(
          (v, [from, to]) =>
            v.replace(
              new RegExp(`(^|[\\s:="'])${escapeRegExp(from)}(?=/|$|[\\s:"'])`, "g"),
              `$1${to}`,
            ),
          value,
        );
  const lines: string[] = [
    "#!/bin/bash",
    `# Infrawrench CI cloud job ${input.name.replace(/[\r\n]/g, " ")}. Holds the job's secrets.`,
    'rm -f -- "$0"',
    "set -u",
    "umask 077",
    `IWCI_CB=${shq(input.callbackUrl)}`,
    `IWCI_H=${shq(`${CI_JOB_TOKEN_HEADER}: ${input.token}`)}`,
    `IWCI_PROXY=${shq(input.proxyUrl.replace(/\/+$/, ""))}`,
    'W=$(mktemp -d "${TMPDIR:-/tmp}/iwci.XXXXXX")',
    isolate
      ? 'if [ -n "${IWCI_WORK:-}" ]; then R="$IWCI_WORK/job"; else R=$(mktemp -d "${TMPDIR:-/tmp}/iwci-root.XXXXXX"); export HOME="$R/home"; fi; mkdir -p "$R" "$HOME"'
      : 'R=""',
    // A value from the claim, with the job's root and HOME put in place.
    `_val() { local v; v="$(printf %s "$1" | base64 -d; echo x)"; v="\${v%x}"; v="\${v//${ROOT}/$R}"; printf %s "\${v//${HOME}/$HOME}"; }`,
    ': > "$W/stdout"; : > "$W/stderr"; echo 0 > "$W/off.stdout"; echo 0 > "$W/off.stderr"',
    // Relays what each stream gained since the last call; nothing to send
    // for 30 seconds sends a heartbeat. A 409 or 404 means the runner
    // ended the job (cancelled, lost, timed out): stop.
    "_call() {",
    '  curl -sS -m 60 -o /dev/null -w "%{http_code}" -X POST -H "$IWCI_H" -H "Content-Type: application/octet-stream" --data-binary @"$2" "$IWCI_CB/$1" 2>/dev/null || echo 000',
    "}",
    "_flush() {",
    "  local s off size n code sent=0",
    "  for s in stdout stderr; do",
    '    off=$(cat "$W/off.$s"); size=$(wc -c < "$W/$s")',
    '    while [ "$size" -gt "$off" ]; do',
    '      n=$((size - off)); [ "$n" -gt 524288 ] && n=524288',
    '      tail -c +$((off + 1)) "$W/$s" | head -c "$n" > "$W/chunk.$s"',
    '      code=$(_call "log?stream=$s" "$W/chunk.$s")',
    '      case "$code" in',
    '        2*) off=$((off + n)); echo "$off" > "$W/off.$s"; sent=1 ;;',
    '        404|409) touch "$W/stop"; return ;;',
    "        *) break ;;",
    "      esac",
    "    done",
    "  done",
    '  if [ "$sent" = 1 ]; then date +%s > "$W/beat"; return; fi',
    '  if [ $(( $(date +%s) - $(cat "$W/beat" 2>/dev/null || echo 0) )) -ge 30 ]; then',
    '    : > "$W/empty"; code=$(_call log "$W/empty")',
    '    case "$code" in 2*) date +%s > "$W/beat" ;; 404|409) touch "$W/stop" ;; esac',
    "  fi",
    "}",
    '_note() { printf "[infrawrench] %s\\n" "$*" >> "$W/stderr"; }',
    // Ends the job: one last flush, then how it went, with $IWCI_OUTPUT on
    // the first line (base64) and `git status --porcelain` after it.
    "_finish() {",
    '  local status="$1" code="$2" timed="$3"',
    '  touch "$W/done"; [ -n "${RELAY:-}" ] && wait "$RELAY" 2>/dev/null',
    "  _flush",
    '  { base64 < "$W/output" 2>/dev/null | tr -d "\\n"; echo; cat "$W/changes" 2>/dev/null; } > "$W/finish"',
    // A reused host's root goes before the report, so nothing of the job
    // outlives what the executor is told.
    '  [ -n "$R" ] && rm -rf "$R"',
    '  _call "finish?status=$status&exit=$code&timed_out=$timed" "$W/finish" > /dev/null',
    '  rm -rf "$W"',
    "  exit 0",
    "}",
    '_fail() { _note "$1"; _finish error 0 0; }',
    ': > "$W/output"',
    '( while [ ! -e "$W/done" ] && [ ! -e "$W/stop" ]; do sleep 2; _flush; done ) &',
    "RELAY=$!",
  ];
  for (const [key, value] of Object.entries(input.env)) {
    if (!ENV_KEY.test(key)) continue;
    lines.push(`export ${key}="$(_val ${shq(b64(rooted(value)))})"`);
  }
  for (const file of input.files) {
    if (!file.path.startsWith("/") || file.path.includes("\n")) continue;
    const mode = file.mode && MODE.test(file.mode) ? file.mode : "600";
    const dir = file.path.replace(/\/[^/]*$/, "") || "/";
    lines.push(
      `install -d -m 700 ${at(dir)} && _val ${shq(b64(rooted(file.content)))} > ${at(file.path)} && chmod ${mode} ${at(file.path)} || _fail ${shq(`could not write ${file.path}`)}`,
    );
  }
  if (input.cloneInto) {
    const into = at(input.cloneInto);
    lines.push(
      // The token goes to the callback only: the archive link it answers is
      // fetched without it, so a redirect never carries it to GitHub.
      `SRC=$(curl -fsS -m 60 -H "$IWCI_H" -o /dev/null -w "%{redirect_url}" "$IWCI_CB/source") && [ -n "$SRC" ] && mkdir -p ${into} && curl -fsSL -m 600 "$SRC" | tar -xzf - --strip-components=1 -C ${into} || _fail "could not fetch the commit"`,
    );
    if (input.changes === "fail") {
      lines.push(
        `if command -v git > /dev/null; then (cd ${into} && git init -q && git add -A && git -c user.name=iwci -c user.email=ci@localhost commit -qm base) > /dev/null 2>&1; fi`,
      );
    }
  }
  if (input.inputsUrl) {
    lines.push(
      `curl -fsS -m 1800 "$IWCI_PROXY"${shq(input.inputsUrl)} | tar -xf - -C "\${R:-/}" || _fail "could not fetch the artifacts of the jobs it needs"`,
    );
  }
  lines.push(
    'export IWCI_OUTPUT="$W/output"',
    `printf %s ${shq(b64(input.script))} | base64 -d > "$W/run.sh"`,
    `cd ${at(input.cwd)} || _fail ${shq(`no such directory: ${input.cwd}`)}`,
    'if command -v timeout > /dev/null; then T="timeout -k 10 ' +
      Math.max(1, Math.trunc(input.timeoutSecs)) +
      '"; else T=""; fi',
    '$T bash -c \'set -euo pipefail; . "$0"\' "$W/run.sh" >> "$W/stdout" 2>> "$W/stderr" < /dev/null &',
    "JOB=$!",
    'while kill -0 "$JOB" 2>/dev/null; do',
    '  if [ -e "$W/stop" ]; then kill -TERM "$JOB" 2>/dev/null; rm -rf "$W"; [ -n "$R" ] && rm -rf "$R"; exit 0; fi',
    "  sleep 1",
    "done",
    'wait "$JOB"; RC=$?',
    'TIMED=0; [ "$RC" = 124 ] && TIMED=1',
  );
  if (input.changes === "fail" && input.cloneInto) {
    lines.push(
      `if command -v git > /dev/null && [ -d ${at(input.cloneInto)}/.git ]; then git -C ${at(input.cloneInto)} status --porcelain > "$W/changes" 2>/dev/null; fi`,
    );
  }
  if (input.artifacts && input.artifacts.paths.length > 0) {
    const rel = input.artifacts.paths.map((p) => shq(p.replace(/^\/+/, "")));
    lines.push(
      'if [ "$RC" = 0 ]; then',
      `  set --; for p in ${rel.join(" ")}; do [ -e "$R/$p" ] && set -- "$@" "$p"; done`,
      `  if [ "$#" -gt 0 ]; then tar -C "\${R:-/}" -cf - "$@" | curl -fsS -m 1800 -T - "$IWCI_PROXY"${shq(input.artifacts.url)} > /dev/null || _note "could not upload the job's artifacts"; fi`,
      "fi",
    );
  }
  lines.push(
    'if [ "$RC" = 0 ]; then _finish passed 0 0; else _finish failed "$RC" "$TIMED"; fi',
    "",
  );
  return lines.join("\n");
}

/** A finish body as the job script sends it: `$IWCI_OUTPUT` (base64) on the first line, `git status --porcelain` after. */
export function parseFinishBody(body: string): {
  output: string;
  changes: Array<{ path: string; kind: "added" | "modified" | "deleted" }>;
} {
  const newline = body.indexOf("\n");
  const first = newline === -1 ? body : body.slice(0, newline);
  const rest = newline === -1 ? "" : body.slice(newline + 1);
  let output = "";
  try {
    output = Buffer.from(first.trim(), "base64").toString("utf8");
  } catch {
    output = "";
  }
  const changes: Array<{ path: string; kind: "added" | "modified" | "deleted" }> = [];
  for (const line of rest.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code.includes("R") && path.includes(" -> ")) {
      const [from, to] = path.split(" -> ");
      if (from) changes.push({ path: from, kind: "deleted" });
      if (to) changes.push({ path: to, kind: "added" });
    } else if (code === "??" || code.includes("A")) {
      changes.push({ path, kind: "added" });
    } else if (code.includes("D")) {
      changes.push({ path, kind: "deleted" });
    } else {
      changes.push({ path, kind: "modified" });
    }
  }
  return { output, changes: changes.slice(0, 10_000) };
}
