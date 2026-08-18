import { describe, expect, it } from "vitest";

import {
  AppServerError,
  installRequirements,
  planInstall,
  probeHost,
  type HostPreflight,
} from "../index.js";
import { FakeSsh, innerScript } from "./fake-ssh.js";

/** The probe's output for a host with everything, as key=value lines. */
function probeOutput(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    os_id: "debian",
    os_name: "Debian GNU/Linux 13 (trixie)",
    arch: "x86_64",
    pm: "apt-get",
    priv: "root",
    gzip: "1",
    xkb: "1",
    dbus: "1",
    fonts: "1",
    mesa: "1",
    icons: "1",
    staging: "1",
    apps: "12",
    ...overrides,
  };
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

const probeReply = (overrides?: Record<string, string>) => [
  { match: /os-release/, stdout: probeOutput(overrides) },
];

describe("probeHost", () => {
  it("reads a host that has everything", async () => {
    const preflight = await probeHost(new FakeSsh(probeReply()));

    expect(preflight.ready).toBe(true);
    expect(preflight.osName).toBe("Debian GNU/Linux 13 (trixie)");
    expect(preflight.packageManager).toBe("apt-get");
    expect(preflight.privilege).toBe("root");
    expect(preflight.appCount).toBe(12);
    expect(preflight.requirements.every((req) => req.ok)).toBe(true);
  });

  it("looks and does not touch", async () => {
    const ssh = new FakeSsh(probeReply());
    await probeHost(ssh);

    // One exec, and nothing in it changes the host: the probe runs before the
    // user has agreed to anything. The manager names do appear — `command -v`
    // is how the probe finds which one there is — so this looks for the verbs.
    expect(ssh.commands).toHaveLength(1);
    const script = innerScript(ssh.commands[0]!);
    expect(script).not.toMatch(/install|add --no-cache|-Sy /);
    // The only thing it writes is the staging probe's own temp file, once per
    // candidate directory, and each is removed again: the only reliable test
    // for `noexec` is to run something from there.
    expect(script.match(/mktemp/g)).toHaveLength(4);
  });

  it("is not ready when a required item is missing, and says which", async () => {
    const preflight = await probeHost(new FakeSsh(probeReply({ dbus: "0", xkb: "0" })));

    expect(preflight.ready).toBe(false);
    const missing = preflight.requirements.filter((req) => !req.ok).map((req) => req.id);
    expect(missing).toEqual(["xkb", "dbus"]);
  });

  it("stays ready when only a recommended item is missing", async () => {
    // No mesa is a browser that renders slowly, not a host that cannot work.
    const preflight = await probeHost(new FakeSsh(probeReply({ mesa: "0" })));

    expect(preflight.ready).toBe(true);
    expect(preflight.requirements.find((req) => req.id === "mesa")?.ok).toBe(false);
  });

  it("is not ready with nowhere to stage the binary, which no package fixes", async () => {
    const preflight = await probeHost(new FakeSsh(probeReply({ staging: "0" })));

    expect(preflight.staging).toBe(false);
    expect(preflight.ready).toBe(false);
    // Nothing to install: every requirement is present.
    expect(planInstall(preflight)).toBeNull();
  });

  it("reads through a login banner", async () => {
    // The classic way this arrives as garbage. A banner line has no `=`, or a
    // key that is not one of ours, so it is simply not a field.
    const ssh = new FakeSsh([
      {
        match: /os-release/,
        stdout: `Welcome to prod-01!\nLast login: Tue Aug 18\nMOTD=do not touch\n${probeOutput()}`,
      },
    ]);
    const preflight = await probeHost(ssh);

    expect(preflight.ready).toBe(true);
    expect(preflight.osId).toBe("debian");
  });

  it("says the probe failed rather than that everything is missing", async () => {
    // An SSH problem must not send the user off to install packages.
    const ssh = new FakeSsh([{ match: /os-release/, stdout: "", stderr: "Killed", code: 137 }]);

    await expect(probeHost(ssh)).rejects.toBeInstanceOf(AppServerError);
  });
});

describe("planInstall", () => {
  const preflightWith = async (overrides: Record<string, string>): Promise<HostPreflight> =>
    await probeHost(new FakeSsh(probeReply(overrides)));

  it("returns null when there is nothing to do", async () => {
    expect(planInstall(await preflightWith({}))).toBeNull();
  });

  it("plans only the required items by default", async () => {
    const plan = planInstall(await preflightWith({ dbus: "0", mesa: "0" }));

    expect(plan?.requirements).toEqual(["dbus"]);
    expect(plan?.packages).toEqual(["dbus"]);
  });

  it("plans a recommended item when asked for it explicitly", async () => {
    const plan = planInstall(await preflightWith({ dbus: "0", mesa: "0" }), {
      include: ["dbus", "mesa"],
    });

    expect(plan?.packages).toEqual(["dbus", "libgl1-mesa-dri"]);
  });

  it("ignores an included item the host already has", async () => {
    const plan = planInstall(await preflightWith({ mesa: "0" }), { include: ["dbus", "mesa"] });

    expect(plan?.requirements).toEqual(["mesa"]);
  });

  it("refreshes the index before installing on apt, and never prompts", async () => {
    const plan = planInstall(await preflightWith({ xkb: "0", fonts: "0" }));

    expect(plan?.commands).toEqual([
      "apt-get update -qq",
      "env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
        "xkb-data fontconfig fonts-dejavu-core",
    ]);
  });

  it("de-duplicates a package two requirements share", async () => {
    const plan = planInstall(await preflightWith({ fonts: "0" }), { include: ["fonts"] });

    expect(plan?.packages.filter((name) => name === "fontconfig")).toHaveLength(1);
  });

  it.each([
    ["dnf", "dnf install -y xkeyboard-config dbus-daemon"],
    ["yum", "yum install -y xkeyboard-config dbus-x11 dbus-daemon"],
    ["apk", "apk add --no-cache xkeyboard-config dbus"],
    ["pacman", "pacman -Sy --noconfirm --needed xkeyboard-config dbus"],
    ["zypper", "zypper --non-interactive --gpg-auto-import-keys install xkeyboard-config dbus-1"],
  ])("drives %s", async (pm, expected) => {
    const plan = planInstall(await preflightWith({ pm, dbus: "0", xkb: "0" }));

    expect(plan?.packageManager).toBe(pm);
    expect(plan?.commands).toEqual([expected]);
  });

  it("installs both icon packages, since one is the fallback and one has the icons", async () => {
    const plan = planInstall(await preflightWith({ icons: "0" }), { include: ["icons"] });

    expect(plan?.packages).toEqual(["hicolor-icon-theme", "adwaita-icon-theme"]);
  });

  it("leaves the cosmetic items out of the default plan", async () => {
    // A host missing only icons and GL still runs applications; nothing is
    // installed on someone's machine without them having asked for it.
    const preflight = await preflightWith({ icons: "0", mesa: "0" });

    expect(preflight.ready).toBe(true);
    expect(planInstall(preflight)).toBeNull();
  });

  it("prefixes sudo -n when the login is not root, so it cannot hang on a password", async () => {
    const plan = planInstall(await preflightWith({ priv: "sudo", dbus: "0" }));

    expect(plan?.canInstall).toBe(true);
    expect(plan?.commands).toEqual([
      "sudo -n apt-get update -qq",
      "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dbus",
    ]);
  });

  it("gives a host that would prompt for sudo the commands but not the button", async () => {
    const plan = planInstall(await preflightWith({ priv: "sudo-password", dbus: "0" }));

    expect(plan?.canInstall).toBe(false);
    expect(plan?.blockedReason).toMatch(/password/);
    // Plain `sudo`, because these are for a person to run rather than for us.
    expect(plan?.commands[0]).toBe("sudo apt-get update -qq");
  });

  it("names the packages even with no package manager it recognises", async () => {
    const plan = planInstall(await preflightWith({ pm: "", dbus: "0" }));

    expect(plan?.canInstall).toBe(false);
    expect(plan?.commands).toEqual([]);
    expect(plan?.packages).toEqual(["dbus"]);
    expect(plan?.blockedReason).toMatch(/package manager/);
  });
});

describe("installRequirements", () => {
  it("installs, then re-probes and reports what the host is now", async () => {
    // The second probe is the one that answers: it is scripted as a fixed host
    // rather than mutating the first, which is what the real one does.
    const ssh = new FakeSsh([
      { match: /iw_install/, stdout: "Setting up dbus\n" },
      { match: /os-release/, stdout: probeOutput() },
    ]);
    const preflight = await probeHost(ssh);
    const plan = planInstall({
      ...preflight,
      requirements: preflight.requirements.map((r) => (r.id === "dbus" ? { ...r, ok: false } : r)),
    })!;

    const outcome = await installRequirements(ssh, plan);

    expect(outcome.log).toContain("Setting up dbus");
    expect(outcome.failed).toEqual([]);
    expect(outcome.preflight.ready).toBe(true);
  });

  it("falls back to one package at a time and names the one that would not install", async () => {
    const ssh = new FakeSsh([
      // The batch fails; each package is then tried alone. The fake cannot
      // model the shell's control flow, so the script's own `iw-failed:`
      // marker is what the assertion is about.
      {
        match: /iw_install/,
        stdout: "E: Unable to locate package\niw-failed: dejavu-fonts\n",
        code: 1,
      },
      { match: /os-release/, stdout: probeOutput({ fonts: "0" }) },
    ]);
    const preflight = await probeHost(ssh);
    const plan = planInstall({
      ...preflight,
      requirements: preflight.requirements.map((r) => (r.id === "fonts" ? { ...r, ok: false } : r)),
    })!;

    const outcome = await installRequirements(ssh, plan);

    expect(outcome.failed).toEqual(["dejavu-fonts"]);
    // Reported honestly rather than as a success: the re-probe still says no.
    expect(outcome.preflight.ready).toBe(false);
  });

  it("tries the batch first and only then each package", async () => {
    const ssh = new FakeSsh([
      { match: /iw_install/, stdout: "" },
      { match: /os-release/, stdout: probeOutput() },
    ]);
    const preflight = await probeHost(ssh);
    const plan = planInstall({
      ...preflight,
      requirements: preflight.requirements.map((r) => (r.id === "fonts" ? { ...r, ok: false } : r)),
    })!;

    await installRequirements(ssh, plan);
    const script = innerScript(ssh.commands.at(-2)!);

    expect(script).toContain("if iw_install 'fontconfig' 'fonts-dejavu-core'; then exit 0; fi");
    expect(script).toContain("for p in 'fontconfig' 'fonts-dejavu-core'; do");
    // A mirror being down must not stop us trying with what is cached.
    expect(script).toContain("apt-get update -qq || echo");
  });

  it("refuses a host it cannot install on rather than running sudo blind", async () => {
    const ssh = new FakeSsh(probeReply({ priv: "none", dbus: "0" }));
    const preflight = await probeHost(ssh);
    const plan = planInstall(preflight)!;

    await expect(installRequirements(ssh, plan)).rejects.toBeInstanceOf(AppServerError);
    // Nothing beyond the probe ever ran.
    expect(ssh.commands).toHaveLength(1);
  });
});
