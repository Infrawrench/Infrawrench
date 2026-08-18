/**
 * What a host needs before it can run applications, and putting it there.
 *
 * `iwappd` is a static binary, so the list is short — but every item on it
 * fails in a way that does not say what is wrong. No `gunzip` and the upload
 * cannot be unpacked. No `xkeyboard-config` and the keyboard silently does
 * nothing, because xkbcommon compiles its keymap from data files even when the
 * library itself is linked in. No session bus and a GTK4 application waits
 * forever without mapping a window. No fonts and Qt aborts while GTK draws
 * empty boxes. Every one of those reaches the user as "I clicked the app and
 * nothing happened", which is the worst error message there is.
 *
 * So we ask first, say what is missing in terms of what it breaks, and offer to
 * install it. Three things shape how:
 *
 * **The probe cannot use `iwappd`.** Staging the binary needs `gunzip`, which
 * is one of the things being checked, so the probe is plain POSIX `sh` in a
 * single exec. It is also why it prints `key=value` lines rather than JSON: a
 * host with a login banner on stdout would break a `JSON.parse`, and here the
 * banner is simply a line with no `=` in it.
 *
 * **This module has no user-facing copy in it beyond English fallbacks.** The
 * UI maps requirement ids to translated strings itself, because gt's extractor
 * needs literal arguments and a string imported from a package is not one. The
 * `summary` fields here are what the CLI prints and what a caller falls back to.
 *
 * **The install is verified by re-probing, not by exit codes.** A package
 * manager exits zero having installed something that does not fix the problem,
 * or non-zero because one name out of five was wrong on this distribution. The
 * only answer worth reporting is a second probe.
 */

import type {
  HostPreflight,
  HostPrivilege,
  HostRequirementsCheck,
  InstallOutcome,
  InstallPlan,
  PackageManager,
  RequirementId,
  RequirementSpec,
} from "@infrawrench/appstream-core";

import {
  AppServerError,
  execCommand,
  execStreaming,
  pickStagingDirScript,
  shellQuote,
  type SshExecutor,
} from "./exec.js";

// The shapes are `@infrawrench/appstream-core`'s, so the launcher UI can render
// them without depending on this Node-typed package. Re-exported here because
// this is where they are produced and where a caller expects to find them.
export type {
  HostPreflight,
  HostPrivilege,
  HostRequirementsCheck,
  InstallOutcome,
  InstallPlan,
  PackageManager,
  RequirementId,
  RequirementSpec,
  RequirementStatus,
} from "@infrawrench/appstream-core";

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  "apt-get",
  "dnf",
  "yum",
  "apk",
  "pacman",
  "zypper",
];

/**
 * The list, in the order it is shown. Ordered by how early it fails: `gzip`
 * stops the upload, `xkb` and `dbus` stop the session being usable, fonts and
 * GL are about what the application then looks like.
 */
export const REQUIREMENTS: readonly RequirementSpec[] = [
  {
    id: "gzip",
    severity: "required",
    title: "gzip",
    summary: "Unpacks the app server after it is uploaded. Nothing starts without it.",
  },
  {
    id: "xkb",
    severity: "required",
    title: "Keyboard layout data",
    summary:
      "xkeyboard-config. Without it the compositor cannot build a keymap and typing does nothing.",
  },
  {
    id: "dbus",
    severity: "required",
    title: "Session D-Bus",
    summary:
      "GTK applications wait for a session bus before showing a window, and never say they are waiting.",
  },
  {
    id: "fonts",
    severity: "required",
    title: "Fonts",
    summary: "Qt exits and GTK draws empty boxes when the host has no fonts installed.",
  },
  {
    id: "mesa",
    severity: "recommended",
    title: "Software OpenGL",
    summary:
      "Browsers and Electron applications need a GL driver; GTK and Qt are pushed onto Cairo instead.",
  },
  {
    id: "icons",
    severity: "recommended",
    title: "Icon theme",
    summary:
      "Without one the launcher shows initials instead of icons, and toolbar buttons show nothing.",
  },
];

/**
 * Packages per requirement per manager.
 *
 * Several entries are lists rather than single names, and the installer
 * tolerates one of them being unknown — distributions disagree about how this
 * is split, and the cost of guessing wrong should be a package that did not
 * install rather than an install that did nothing.
 *
 * Verified against the distributions' own package indexes rather than from
 * memory: `dbus-run-session` moved out of `dbus` into `dbus-daemon` on Debian
 * (bookworm onwards) and lives in `dbus-daemon` on Fedora, so apt installs the
 * `dbus` package that depends on both and works on every release either way.
 */
const PACKAGES: Record<RequirementId, Record<PackageManager, readonly string[]>> = {
  gzip: {
    "apt-get": ["gzip"],
    dnf: ["gzip"],
    yum: ["gzip"],
    apk: ["gzip"],
    pacman: ["gzip"],
    zypper: ["gzip"],
  },
  xkb: {
    "apt-get": ["xkb-data"],
    dnf: ["xkeyboard-config"],
    yum: ["xkeyboard-config"],
    apk: ["xkeyboard-config"],
    pacman: ["xkeyboard-config"],
    zypper: ["xkeyboard-config"],
  },
  dbus: {
    "apt-get": ["dbus"],
    dnf: ["dbus-daemon"],
    // EL7's dbus-run-session shipped in dbus-x11; dbus-daemon is the name from
    // EL8 on. Both are offered and the odd one out is skipped.
    yum: ["dbus-x11", "dbus-daemon"],
    apk: ["dbus"],
    pacman: ["dbus"],
    zypper: ["dbus-1"],
  },
  fonts: {
    "apt-get": ["fontconfig", "fonts-dejavu-core"],
    dnf: ["fontconfig", "dejavu-sans-fonts"],
    yum: ["fontconfig", "dejavu-sans-fonts"],
    apk: ["fontconfig", "font-dejavu"],
    pacman: ["fontconfig", "ttf-dejavu"],
    zypper: ["fontconfig", "dejavu-fonts"],
  },
  mesa: {
    "apt-get": ["libgl1-mesa-dri"],
    dnf: ["mesa-dri-drivers"],
    yum: ["mesa-dri-drivers"],
    apk: ["mesa-dri-gallium"],
    pacman: ["mesa"],
    zypper: ["Mesa-dri"],
  },
  // hicolor is the theme every application falls back into, and Adwaita is
  // what supplies an actual icon for the ones that only name a stock id. Both
  // are freedesktop packages with the same name nearly everywhere.
  icons: {
    "apt-get": ["hicolor-icon-theme", "adwaita-icon-theme"],
    dnf: ["hicolor-icon-theme", "adwaita-icon-theme"],
    yum: ["hicolor-icon-theme", "adwaita-icon-theme"],
    apk: ["hicolor-icon-theme", "adwaita-icon-theme"],
    pacman: ["hicolor-icon-theme", "adwaita-icon-theme"],
    zypper: ["hicolor-icon-theme", "adwaita-icon-theme"],
  },
};

/**
 * One `sh` script that answers everything, printing `key=value` lines.
 *
 * Deliberately does nothing but look: it is run before the user has agreed to
 * anything, on a machine that is not ours.
 */
function probeScript(): string {
  return [
    // os-release is sourced in a subshell so a variable it sets cannot collide
    // with one used below.
    `( [ -r /etc/os-release ] && . /etc/os-release 2>/dev/null; \\`,
    `  printf 'os_id=%s\\n' "\${ID:-unknown}"; \\`,
    `  printf 'os_name=%s\\n' "\${PRETTY_NAME:-\${NAME:-unknown}}" )`,
    `printf 'arch=%s\\n' "$(uname -m 2>/dev/null || echo unknown)"`,
    `have() { command -v "$1" >/dev/null 2>&1; }`,

    // Package manager, first match wins.
    `pm=`,
    `for c in ${PACKAGE_MANAGERS.join(" ")}; do have "$c" && { pm=$c; break; }; done`,
    `printf 'pm=%s\\n' "$pm"`,

    // Privilege. `sudo -n` never prompts, so this cannot hang on a password.
    `if [ "$(id -u 2>/dev/null)" = "0" ]; then priv=root`,
    `elif have sudo && sudo -n true >/dev/null 2>&1; then priv=sudo`,
    `elif have sudo; then priv=sudo-password`,
    `else priv=none; fi`,
    `printf 'priv=%s\\n' "$priv"`,

    // gzip: the upload is a gzip stream, and this unpacks it.
    `have gunzip && printf 'gzip=1\\n' || printf 'gzip=0\\n'`,

    // XKB data. XKB_CONFIG_ROOT is honoured because a host can move it, and
    // the symbols directory is checked as well as the rules files because a
    // slimmed package may ship one without the other.
    `xkb=0`,
    `for r in "\${XKB_CONFIG_ROOT:-}" /usr/share/X11/xkb /usr/local/share/X11/xkb; do`,
    `  [ -n "$r" ] || continue`,
    `  { [ -f "$r/rules/evdev.xml" ] || [ -f "$r/rules/base.xml" ] || [ -d "$r/symbols" ]; } && xkb=1 && break`,
    `done`,
    `printf 'xkb=%s\\n' "$xkb"`,

    // A session bus, or the means to start one. An inherited address is
    // unlikely down a non-interactive exec, but it is what iwappd itself
    // prefers, so it is checked in the same order.
    `dbus=0`,
    `[ -n "\${DBUS_SESSION_BUS_ADDRESS:-}" ] && dbus=1`,
    `for b in "\${XDG_RUNTIME_DIR:-}/bus" "/run/user/$(id -u 2>/dev/null)/bus"; do`,
    `  [ -S "$b" ] && dbus=1`,
    `done`,
    `have dbus-run-session && dbus=1`,
    `printf 'dbus=%s\\n' "$dbus"`,

    // Any scalable font at all. `head -n1` rather than find's -quit, which
    // BusyBox has not always had.
    `fonts=0`,
    `for d in /usr/share/fonts /usr/local/share/fonts "\${HOME:-/root}/.local/share/fonts" "\${HOME:-/root}/.fonts"; do`,
    `  [ -d "$d" ] || continue`,
    `  f=$(find "$d" -type f \\( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' -o -name '*.pfb' \\) 2>/dev/null | head -n 1)`,
    `  [ -n "$f" ] && fonts=1 && break`,
    `done`,
    `printf 'fonts=%s\\n' "$fonts"`,

    // Software GL. Mesa 24 collapsed the per-driver modules into one
    // libgallium, so both shapes are accepted, and a bare libGL counts.
    `mesa=0`,
    `for d in /usr/lib /usr/lib64 /usr/lib/*-linux-gnu* /usr/lib32; do`,
    `  m=$(ls "$d"/dri/*swrast*.so "$d"/dri/libgallium*.so "$d"/libGL.so.1 2>/dev/null | head -n 1)`,
    `  [ -n "$m" ] && mesa=1 && break`,
    `done`,
    `printf 'mesa=%s\\n' "$mesa"`,

    // An icon theme with an index — a directory with no index.theme is one a
    // resolver walks and finds nothing in.
    `icons=0`,
    `for d in /usr/share/icons /usr/local/share/icons "\${HOME:-/root}/.local/share/icons"; do`,
    `  [ -d "$d" ] || continue`,
    `  i=$(ls "$d"/*/index.theme 2>/dev/null | head -n 1)`,
    `  [ -n "$i" ] && icons=1 && break`,
    `done`,
    `printf 'icons=%s\\n' "$icons"`,

    // Somewhere to put the binary. The same script the staging path uses, so
    // this cannot pass a check the upload then fails.
    `staging=$(${pickStagingDirScript()})`,
    `[ -n "$staging" ] && printf 'staging=1\\n' || printf 'staging=0\\n'`,

    // Desktop entries. A hint rather than a requirement: an empty host is a
    // host with nothing installed, which is a sentence to say and not a thing
    // to fix on the user's behalf.
    `n=0`,
    `for d in /usr/share/applications /usr/local/share/applications "\${HOME:-/root}/.local/share/applications"; do`,
    `  [ -d "$d" ] || continue`,
    `  c=$(ls "$d"/*.desktop 2>/dev/null | wc -l)`,
    `  n=$((n + c))`,
    `done`,
    `printf 'apps=%s\\n' "$n"`,
    // Always succeed: a failed check is a `0`, not an exit code, and a
    // non-zero exit here would be read as "the probe could not run".
    `exit 0`,
  ].join("\n");
}

/** Parse `key=value` lines, ignoring anything else — a login banner, typically. */
function parseFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    // Keys are the fixed set below; anything else is a shell line in a banner.
    if (!/^[a-z_]+$/.test(key)) continue;
    fields.set(key, line.slice(at + 1).trim());
  }
  return fields;
}

function asPackageManager(value: string | undefined): PackageManager | null {
  return PACKAGE_MANAGERS.find((candidate) => candidate === value) ?? null;
}

function asPrivilege(value: string | undefined): HostPrivilege {
  switch (value) {
    case "root":
    case "sudo":
    case "sudo-password":
      return value;
    default:
      return "none";
  }
}

/**
 * Ask the host what it has. One exec, nothing written, nothing changed.
 */
export async function probeHost(conn: SshExecutor): Promise<HostPreflight> {
  const result = await execCommand(conn, `sh -c ${shellQuote(probeScript())}`);
  const fields = parseFields(result.stdout);

  // Every check answers with a `0` or a `1`. A host that answered with none of
  // them did not run the script at all, and reporting that as "everything is
  // missing" would send the user to install packages over an SSH problem.
  if (!fields.has("staging") && !fields.has("gzip")) {
    throw new AppServerError(
      "could not check what this host has installed",
      result.stderr.trim() || `exit ${result.code}`,
    );
  }

  const requirements = REQUIREMENTS.map((spec) => ({
    ...spec,
    ok: fields.get(spec.id) === "1",
  }));
  const staging = fields.get("staging") === "1";

  return {
    arch: fields.get("arch") || "unknown",
    osId: fields.get("os_id") || "unknown",
    osName: fields.get("os_name") || "unknown",
    packageManager: asPackageManager(fields.get("pm")),
    privilege: asPrivilege(fields.get("priv")),
    requirements,
    staging,
    appCount: Number.parseInt(fields.get("apps") ?? "0", 10) || 0,
    ready: staging && requirements.every((req) => req.severity !== "required" || req.ok),
  };
}

/**
 * How each manager installs, as the head of a command the packages are appended
 * to.
 *
 * `env VAR=…` rather than `VAR=… sudo` because the assignment has to survive
 * sudo, and rather than `sudo VAR=… cmd` because a policy can refuse that.
 */
function installerFor(pm: PackageManager, prefix: string): { update?: string; install: string } {
  switch (pm) {
    case "apt-get":
      return {
        update: `${prefix}apt-get update -qq`,
        install: `${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends`,
      };
    case "dnf":
      return { install: `${prefix}dnf install -y` };
    case "yum":
      return { install: `${prefix}yum install -y` };
    case "apk":
      // No separate update step: --no-cache fetches the index for this run and
      // leaves nothing behind, which is the same bargain as the binary itself.
      return { install: `${prefix}apk add --no-cache` };
    case "pacman":
      return { install: `${prefix}pacman -Sy --noconfirm --needed` };
    case "zypper":
      return { install: `${prefix}zypper --non-interactive --gpg-auto-import-keys install` };
  }
}

function privilegePrefix(privilege: HostPrivilege): string {
  // `sudo -n` for the automated path so a host that would prompt fails fast
  // instead of hanging on a password nobody can type. The copyable command for
  // the manual path uses plain `sudo`, which is what a person would run.
  switch (privilege) {
    case "root":
      return "";
    case "sudo":
      return "sudo -n ";
    default:
      return "sudo ";
  }
}

/**
 * What it would take to fix this host.
 *
 * Returns null only when there is nothing to do. A host we cannot install on
 * still gets a plan — with `canInstall` false and the commands filled in — so
 * the user can run them themselves rather than being told "unsupported".
 */
export function planInstall(
  preflight: HostPreflight,
  options: { include?: readonly RequirementId[] } = {},
): InstallPlan | null {
  const wanted =
    options.include ??
    preflight.requirements.filter((req) => !req.ok && req.severity === "required").map((r) => r.id);

  const missing = wanted.filter((id) => {
    const status = preflight.requirements.find((req) => req.id === id);
    return status ? !status.ok : false;
  });
  if (missing.length === 0) return null;

  const pm = preflight.packageManager;
  if (!pm) {
    return {
      // A plan with no manager cannot name commands, but it can still name the
      // packages, which is the useful half on a distribution we do not know.
      packageManager: "apt-get",
      privilege: preflight.privilege,
      requirements: missing,
      packages: missing.flatMap((id) => [...PACKAGES[id]["apt-get"]]),
      commands: [],
      canInstall: false,
      blockedReason:
        "No package manager we recognise (apt, dnf, yum, apk, pacman or zypper) is on this host.",
    };
  }

  // De-duplicated: fontconfig turns up under more than one requirement on some
  // managers, and installing it twice is noise in the log the user reads.
  const packages = [...new Set(missing.flatMap((id) => PACKAGES[id][pm]))];
  const prefix = privilegePrefix(preflight.privilege);
  const installer = installerFor(pm, prefix);
  const commands = [
    ...(installer.update ? [installer.update] : []),
    `${installer.install} ${packages.join(" ")}`,
  ];

  const canInstall = preflight.privilege === "root" || preflight.privilege === "sudo";
  return {
    packageManager: pm,
    privilege: preflight.privilege,
    requirements: missing,
    packages,
    commands,
    canInstall,
    ...(canInstall
      ? {}
      : {
          blockedReason:
            preflight.privilege === "sudo-password"
              ? "This login needs a password for sudo, which cannot be asked for over this connection."
              : "This login cannot install packages: it is not root and has no sudo.",
        }),
  };
}

/**
 * Probe and plan in one call — what every caller of `probeHost` actually wants.
 *
 * Both apps expose exactly this over their own transport, so having it here
 * means neither can forget to send the plan alongside the preflight.
 */
export async function checkHost(conn: SshExecutor): Promise<HostRequirementsCheck> {
  const preflight = await probeHost(conn);
  return { preflight, plan: planInstall(preflight) };
}

/**
 * Install the plan, then look again.
 *
 * The batch is tried first because it is one transaction and much faster; on
 * failure each package is tried alone, so one name this distribution spells
 * differently costs that package rather than all of them. Either way the
 * verdict comes from the second probe.
 */
export async function installRequirements(
  conn: SshExecutor,
  plan: InstallPlan,
  options: { onOutput?: (line: string) => void } = {},
): Promise<InstallOutcome> {
  if (!plan.canInstall) {
    throw new AppServerError(
      "cannot install packages on this host",
      plan.blockedReason ?? "no privileges",
    );
  }

  const log: string[] = [];
  const record = (line: string) => {
    log.push(line);
    options.onOutput?.(line);
  };

  const installer = installerFor(plan.packageManager, privilegePrefix(plan.privilege));

  const args = plan.packages.map((name) => shellQuote(name)).join(" ");
  const script = [
    `iw_install() { ${installer.install} "$@"; }`,
    ...(installer.update
      ? [
          // A stale index makes the install fail for a reason that has nothing
          // to do with the packages, but a mirror that is down should not stop
          // us trying with what is already cached.
          `${installer.update} || echo 'iw: could not refresh the package index, trying anyway' >&2`,
        ]
      : []),
    `if iw_install ${args}; then exit 0; fi`,
    `echo 'iw: installing one at a time' >&2`,
    `rc=0`,
    `for p in ${args}; do iw_install "$p" || { echo "iw-failed: $p"; rc=1; }; done`,
    `exit $rc`,
  ].join("\n");

  await execStreaming(conn, `sh -c ${shellQuote(script)}`, record);

  // Parsed from the log rather than from the exit code, which cannot say which
  // of five packages was the problem.
  const failed = log
    .filter((line) => line.startsWith("iw-failed: "))
    .map((line) => line.slice("iw-failed: ".length).trim());

  return { log, failed, preflight: await probeHost(conn) };
}
