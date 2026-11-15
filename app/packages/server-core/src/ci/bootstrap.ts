/**
 * The scripts that run a cloud job on a machine, the same for every provider.
 *
 * - The **bootstrap** is what the plugin starts the machine with (EC2 user
 *   data, a startup script, a build step, a container's command). It holds
 *   the job's callback URL and a per-job random token, and nothing else
 *   secret. It makes sure the machine has what the job script needs (`bash`,
 *   `curl`, `tar`, `gzip`, `base64`), installing what is missing with the
 *   image's package manager where it is root on fresh compute, and when it
 *   cannot it tells the callback why, so the job fails at once with the
 *   reason instead of as a machine that never called. Then it fetches the
 *   job script once, with the token, and runs it.
 * - The **job script** is served once to the machine by the callback
 *   (`GET /api/ci-jobs/script`, the token in a header) and holds the job's secrets (its
 *   environment and lent files), so it is never in user data, a log or the
 *   database. It writes what the job is lent, puts the programs those need on
 *   the machine (`ssh`, `kubectl`: see {@link JobScriptInput.tools}), fetches
 *   the commit (a GitHub source archive, through the callback, which
 *   redirects to a short-lived link), the artifacts of the jobs it needs
 *   (from the CI proxy, with the claim's token), runs `run:` with `set -euo
 *   pipefail` in `cwd` under the job's timeout, streams its output and a
 *   heartbeat back to the callback (which relays them to the runner, which
 *   masks them), uploads its artifacts, and reports how it ended with
 *   `$IWCI_OUTPUT` and, for `changes: fail`, what changed.
 *
 * **Where things land.** The claim is written for the runner's own jobs,
 * which are root with `HOME=/root` and the commit in `/app`. A machine may
 * be neither, so every `/root` in a lent file's path or a value becomes the
 * home directory of the user the job runs as (the one OpenSSH reads,
 * whatever `HOME` says; `HOME` when that one cannot be written; a temporary
 * one when neither can), and a job that cannot write the clone's directory
 * gets a root of its own to put it under, as a job on a reused host always
 * does. On a fresh machine where the job is root none of that changes a
 * path.
 *
 * `git` is only needed for `changes: fail`. A source archive has no history,
 * no submodules and Git LFS pointers rather than their files, and is not a
 * repository (as on the runner), so a job that needs any of those fetches it
 * in its own script.
 */
import type { CiToolDeclaration } from "@infrawrench/plugin-base";

/** A value quoted for a POSIX shell, as one word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** The header a machine sends its per-job token in: never in a URL, so never in a request log. */
export const CI_JOB_TOKEN_HEADER = "X-Infrawrench-Ci-Job";

export interface BootstrapOptions {
  /**
   * Install what the job script needs with the machine's package manager
   * when it is missing (the default). False for a machine that outlives the
   * job (a reused host), whose packages are its owner's: there the job fails
   * naming what is missing.
   */
  install?: boolean;
}

/** The machine's start-up script. */
export function bootstrapScript(
  callbackUrl: string,
  token: string,
  options: BootstrapOptions = {},
): string {
  const install = options.install !== false;
  const header = `${CI_JOB_TOKEN_HEADER}: $IWCI_TOKEN`;
  return [
    "#!/bin/sh",
    "# Infrawrench CI: fetch this job from Infrawrench and run it.",
    "umask 077",
    `IWCI_CB=${shq(callbackUrl)}`,
    `IWCI_TOKEN=${shq(token)}`,
    '_has() { command -v "$1" >/dev/null 2>&1; }',
    // With whatever here speaks HTTPS: an image without curl often has wget.
    "_post() {",
    `  if _has curl; then curl -fsS -m 30 -o /dev/null -H "${header}" -H "Content-Type: application/octet-stream" --data-binary "$2" "$IWCI_CB/$1" 2>/dev/null`,
    `  elif _has wget; then wget -q -T 30 -O /dev/null --header "${header}" --header "Content-Type: application/octet-stream" --post-data "$2" "$IWCI_CB/$1" 2>/dev/null`,
    "  fi",
    "}",
    // Says why the job cannot start, and ends it.
    "_give_up() {",
    '  echo "Infrawrench CI: $1" >&2',
    '  _post "log?stream=stderr" "[infrawrench] $1',
    '"',
    '  _post "finish?status=error&exit=0&timed_out=0" ""',
    "  exit 127",
    "}",
    'need=""',
    'for t in bash curl tar gzip base64; do _has "$t" || need="$need $t"; done',
    'if [ -n "$need" ]; then',
    ...(install
      ? [
          // Only what is missing: a package that conflicts with one the
          // image has (curl beside curl-minimal) would fail the rest too.
          '  if [ "$(id -u)" = 0 ]; then',
          '    pk=""',
          '    for t in $need; do case "$t" in base64) pk="$pk coreutils" ;; curl) pk="$pk curl ca-certificates" ;; *) pk="$pk $t" ;; esac; done',
          "    if _has apt-get; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pk",
          "    elif _has apk; then apk add --no-cache $pk",
          "    elif _has dnf; then dnf install -y -q $pk",
          "    elif _has microdnf; then microdnf install -y $pk",
          "    elif _has yum; then yum install -y -q $pk",
          "    elif _has zypper; then zypper -n -q install $pk",
          "    elif _has pacman; then pacman -Sy --noconfirm --needed $pk",
          "    fi >/dev/null 2>&1",
          "  fi",
        ]
      : []),
    '  missing=""',
    '  for t in $need; do _has "$t" || missing="$missing $t"; done',
    install
      ? '  [ -z "$missing" ] || _give_up "This machine has no$missing, and Infrawrench could not install it. A cloud job needs bash, curl, tar, gzip and base64: use an image that has them, or one where the job is root and apt, apk, dnf, yum, zypper or pacman can install them."'
      : '  [ -z "$missing" ] || _give_up "This host has no$missing. A cloud job needs bash, curl, tar, gzip and base64: install them on the host."',
    "fi",
    "i=0",
    // Its own file: a reused host may run several jobs at once.
    'F=$(mktemp "${TMPDIR:-/tmp}/iwci-job.XXXXXX") || exit 1',
    'while [ "$i" -lt 30 ]; do',
    `  if curl -fsS -m 60 -H "${header}" -o "$F" "$IWCI_CB/script"; then exec bash "$F"; fi`,
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
   * Absolute paths the job's own script writes are its business. Nothing is
   * installed with the host's package manager.
   *
   * Fresh compute gets a root of its own too, but only when the job cannot
   * write the clone's directory (an image that does not run as root).
   */
  isolate?: boolean;
  /**
   * The programs what the job is lent is used with, as the plugins that
   * lend it declare them (`ciCredential.tools`), and OpenSSH's client for a
   * lent SSH key. Each one the machine has no command for is installed from
   * its package (root, fresh compute) or downloaded into the job's own
   * directory and checked against its SHA-256, before the job's script
   * runs. One that cannot be had is a line in the job's log, not a failure:
   * the script may never call it.
   */
  tools?: readonly CiToolDeclaration[];
}

/** Stand for the job's root and its home in values, filled in on the machine. */
const ROOT = "@@IWCI_ROOT@@";
const HOME = "@@IWCI_HOME@@";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODE = /^[0-7]{3,4}$/;
/** A command or a package name: one plain word. The manifest schema holds plugins to the same. */
const TOOL_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The package manager commands a declared package manager stands for. */
const PACKAGE_MANAGER_COMMANDS: Readonly<Record<string, string>> = {
  apt: "apt-get",
  apk: "apk",
  dnf: "dnf|microdnf|yum",
  zypper: "zypper",
  pacman: "pacman",
};

/** What `uname -m` says for a declared architecture. */
const ARCHITECTURE_NAMES: Readonly<Record<string, string>> = {
  x86_64: "x86_64|amd64",
  aarch64: "aarch64|arm64",
};

/**
 * The lines that put the declared tools on the machine. Everything in a
 * declaration is checked again here before it goes into a script that may
 * run as root: a tool with anything but plain words, an HTTPS URL and a
 * SHA-256 is left out.
 */
function toolLines(tools: readonly CiToolDeclaration[], isolate: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tool of tools) {
    if (!TOOL_WORD.test(tool.command) || seen.has(tool.command)) continue;
    seen.add(tool.command);
    const packages = Object.entries(tool.packages ?? {}).flatMap(([manager, name]) => {
      const commands = PACKAGE_MANAGER_COMMANDS[manager];
      return commands && typeof name === "string" && TOOL_WORD.test(name)
        ? [`${commands}) _pkg ${shq(name)} ;;`]
        : [];
    });
    const downloads = Object.entries(tool.downloads ?? {}).flatMap(([arch, download]) => {
      const names = ARCHITECTURE_NAMES[arch];
      const ok =
        names &&
        download &&
        /^https:\/\/[^\s'"\\]+$/.test(download.url) &&
        SHA256.test(download.sha256);
      return ok
        ? [`${names}) _dl ${shq(tool.command)} ${shq(download.url)} ${shq(download.sha256)} ;;`]
        : [];
    });
    const has = `command -v ${shq(tool.command)} > /dev/null 2>&1`;
    out.push(`if ! ${has}; then`);
    // A reused host's packages are its owner's.
    if (packages.length > 0 && !isolate) {
      out.push(`  if [ "$(id -u)" = 0 ]; then case "$_PM" in ${packages.join(" ")} esac; fi`);
    }
    if (downloads.length > 0) {
      out.push(`  ${has} || case "$(uname -m)" in ${downloads.join(" ")} esac`);
    }
    out.push(
      `  ${has} || _note ${shq(
        `This machine has no ${tool.command}, which what the job is lent is used with, and Infrawrench could not put it here${
          packages.length > 0 && downloads.length === 0
            ? isolate
              ? ": install it on the host."
              : ": it comes from the image's packages, which takes a job that is root and apt, apk, dnf, yum, zypper or pacman. Use an image that has it."
            : "."
        }`,
      )}`,
      "fi",
    );
  }
  if (out.length === 0) return [];
  return [
    '_PM=""; for m in apt-get apk dnf microdnf yum zypper pacman; do if command -v "$m" > /dev/null 2>&1; then _PM="$m"; break; fi; done',
    "_pkg() {",
    '  case "$_PM" in',
    '    apt-get) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" ;;',
    '    apk) apk add --no-cache "$@" ;;',
    '    dnf|yum) "$_PM" install -y -q "$@" ;;',
    '    microdnf) microdnf install -y "$@" ;;',
    '    zypper) zypper -n -q install "$@" ;;',
    '    pacman) pacman -Sy --noconfirm --needed "$@" ;;',
    "    *) return 1 ;;",
    "  esac > /dev/null 2>&1 < /dev/null",
    "}",
    // A download is used only when it is the file its declaration pinned.
    "_dl() {",
    '  local part="$W/bin/.$1.part" sum',
    '  curl -fsSL -m 600 -o "$part" "$2" 2> /dev/null || { rm -f "$part"; return 1; }',
    '  sum=$( { sha256sum "$part" 2> /dev/null || shasum -a 256 "$part" 2> /dev/null; } | cut -d " " -f 1)',
    '  if [ "$sum" = "$3" ]; then chmod 755 "$part" && mv "$part" "$W/bin/$1"; else rm -f "$part"; _note "The download of $1 was not the file Infrawrench expects (its SHA-256 differs), so it was not used."; return 1; fi',
    "}",
    ...out,
  ];
}

/** The script the callback serves the machine. Holds secrets: never log it. */
export function jobScript(input: JobScriptInput): string {
  const isolate = input.isolate === true;
  const underHome = (path: string) => path === "/root" || path.startsWith("/root/");
  // An absolute path as the job sees it: under the job's home (for
  // `/root/...`) or under its root, which is empty when the job needs none.
  const at = (path: string) =>
    underHome(path) ? `"$LH"${shq(path.slice("/root".length))}` : `"$R"${shq(path)}`;
  // A value with those paths marked, so the machine puts its own in place.
  const moves: Array<[string, string]> = [
    ["/root", HOME],
    ...(input.cloneInto && input.cloneInto !== "/"
      ? ([[input.cloneInto, `${ROOT}${input.cloneInto}`]] as Array<[string, string]>)
      : []),
  ];
  const rooted = (value: string) =>
    moves.reduce(
      (v, [from, to]) =>
        v.replace(new RegExp(`(^|[\\s:="'])${escapeRegExp(from)}(?=/|$|[\\s:"'])`, "g"), `$1${to}`),
      value,
    );
  // Where the job starts: the clone, or its working directory without one.
  const anchor = input.cloneInto ?? input.cwd;
  const tools = toolLines(input.tools ?? [], isolate);
  const lendsSsh = input.files.some((f) => f.path.startsWith("/root/.ssh/"));
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
    'mkdir -p "$W/bin"',
    // The user's own home, whatever HOME says: the one OpenSSH reads.
    "P=$(unset HOME; echo ~)",
    ...(isolate
      ? [
          'if [ -n "${IWCI_WORK:-}" ]; then R="$IWCI_WORK/job"; else R=$(mktemp -d "${TMPDIR:-/tmp}/iwci-root.XXXXXX"); export HOME="$R/home"; fi; mkdir -p "$R" "$HOME"',
          'LH="$HOME"',
        ]
      : [
          'R=""',
          // Where `/root` lands: the user's own home, or HOME, or a
          // temporary one, whichever can be written first.
          'if [ "$P" != / ] && mkdir -p "$P" 2> /dev/null && [ -w "$P" ]; then LH="$P"',
          'elif [ -n "${HOME:-}" ] && [ "$HOME" != / ] && mkdir -p "$HOME" 2> /dev/null && [ -w "$HOME" ]; then LH="$HOME"',
          'else LH="$W/home"; mkdir -p "$LH"; fi',
          // A job that cannot write where it starts gets a root of its own.
          `if ! { mkdir -p ${shq(anchor)} 2> /dev/null && [ -w ${shq(anchor)} ]; }; then R="$W/root"; mkdir -p "$R"; fi`,
        ]),
    // A value from the claim, with the job's root and home put in place.
    `_val() { local v; v="$(printf %s "$1" | base64 -d; echo x)"; v="\${v%x}"; v="\${v//${ROOT}/$R}"; printf %s "\${v//${HOME}/$LH}"; }`,
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
    // A job's own root goes before the report, so nothing of the job
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
      // A directory made for it is the job's alone; one that is there keeps its mode.
      `{ [ -d ${at(dir)} ] || install -d -m 700 ${at(dir)}; } && _val ${shq(b64(rooted(file.content)))} > ${at(file.path)} && chmod ${mode} ${at(file.path)} || _fail ${shq(`could not write ${file.path}`)}`,
    );
  }
  if (tools.length > 0 || lendsSsh) {
    // After the job's own `env:`, which may set PATH.
    lines.push('export PATH="$W/bin:$PATH"', ...tools);
  }
  if (lendsSsh) {
    lines.push(
      // OpenSSH reads `~/.ssh/config` from the user's own home, not HOME.
      // Where the lent one is somewhere else, the job's `ssh`, `scp` and
      // `sftp` are told where, so the entries work as they are written.
      'if [ "$LH" != "$P" ] && [ -e "$LH/.ssh/config" ]; then',
      "  for t in ssh scp sftp; do",
      '    real=$(command -v "$t" 2> /dev/null) || continue',
      '    printf \'#!/bin/bash\\nexec %q -F %q "$@"\\n\' "$real" "$LH/.ssh/config" > "$W/bin/.$t" && chmod 755 "$W/bin/.$t" && mv "$W/bin/.$t" "$W/bin/$t"',
      "  done",
      "fi",
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
  } else {
    // Without a clone nothing else makes the directory the job starts in.
    lines.push(`mkdir -p ${at(input.cwd)} 2> /dev/null`);
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
