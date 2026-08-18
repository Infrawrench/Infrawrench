/**
 * What a host needs installed before it can run applications — the contract,
 * not the checking.
 *
 * The checking is `@infrawrench/appstream-host`, which runs a shell script over
 * SSH and produces these. The types live here instead because the launcher UI
 * renders them, and `@infrawrench/ui` cannot depend on that package: it is
 * Node-typed (Buffers, ssh2 channels) and the UI package has no Node types at
 * all. This module is the same bargain the rest of `appstream-core` makes —
 * transport-free, DOM-free, shared by both ends.
 *
 * Unlike everything else in this package, none of this crosses the `iw-proto`
 * wire. It is our own shell probe's answer, so it has no counterpart in the
 * Rust workspace and no golden fixtures.
 */

/** Package managers the installer knows how to drive. */
export type PackageManager = "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "zypper";

/**
 * What the host can be made to do about its own packages.
 *
 * `sudo-password` is separate from `none` because they need different things
 * said to the user: one is "we cannot ask for your password over this
 * connection", the other is "this login cannot install anything at all".
 */
export type HostPrivilege = "root" | "sudo" | "sudo-password" | "none";

export type RequirementId = "gzip" | "xkb" | "dbus" | "fonts" | "mesa" | "icons";

export interface RequirementSpec {
  id: RequirementId;
  /**
   * `required` means applications will not work, or will not be usable, until
   * it is there. `recommended` means some of them will not.
   */
  severity: "required" | "recommended";
  /** English label, for the CLI and as a fallback. The UIs translate their own. */
  title: string;
  /** What breaks without it, in one sentence. English, for the same reason. */
  summary: string;
}

export interface RequirementStatus extends RequirementSpec {
  ok: boolean;
}

export interface HostPreflight {
  /** `uname -m`, unnormalised — the probe reports what the host said. */
  arch: string;
  /** `ID` from os-release, e.g. `debian`, or `unknown`. */
  osId: string;
  /** `PRETTY_NAME`, for showing the user which host they are looking at. */
  osName: string;
  packageManager: PackageManager | null;
  privilege: HostPrivilege;
  requirements: RequirementStatus[];
  /**
   * A writable, exec-capable directory was found to stage the app server in.
   *
   * No package fixes this — it means every candidate is missing, full, or
   * mounted `noexec` — so it is reported separately from the requirements.
   */
  staging: boolean;
  /** Desktop entries found. Zero is not an error; it means nothing to launch. */
  appCount: number;
  /** Every required item present, and somewhere to stage the app server. */
  ready: boolean;
}

export interface InstallPlan {
  packageManager: PackageManager;
  /** The privilege the commands were built for, so the installer reuses it. */
  privilege: HostPrivilege;
  /** Which requirements this plan is meant to satisfy. */
  requirements: RequirementId[];
  packages: string[];
  /**
   * Exactly what will run, one command per line, privilege prefix included.
   *
   * Shown to the user before they agree to it and offered for copying, because
   * this installs packages as root on a machine that is not ours and "trust us"
   * is not an acceptable amount of detail.
   */
  commands: string[];
  /** False when the host can be probed but not changed from here. */
  canInstall: boolean;
  /** Why not, when `canInstall` is false. English; the UIs have their own copy. */
  blockedReason?: string;
}

export interface InstallOutcome {
  /** Every line the package manager printed, in order. */
  log: string[];
  /** Packages that would not install — a name this distribution does not have. */
  failed: string[];
  /** The host as it is now. The only trustworthy statement about the result. */
  preflight: HostPreflight;
}

/**
 * What a check answers with: the host as it is, and what would fix it.
 *
 * The plan travels with the preflight because the UI shows the commands
 * *before* offering the button — a second round trip to find out what would
 * run would mean rendering the offer before knowing what it was.
 */
export interface HostRequirementsCheck {
  preflight: HostPreflight;
  /** Null when nothing is missing that installing a package would fix. */
  plan: InstallPlan | null;
}
