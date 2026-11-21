// The standalone CLI's install script (website/public/cli/install.sh, served
// at https://infrawrench.com/cli/install.sh), run against a fake release on
// disk with `uname` and `ldd` stubbed, so it is checked for every platform it
// picks an asset for without downloading anything.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "../../../website/public/cli/install.sh");

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let tmp: string;
  let release: string;
  let bin: string;
  let stubs: string;

  /** A fake `infrawrench` packed the way `package-cli.mjs` packs the real one. */
  function publish(asset: string, sums?: string): void {
    const staging = path.join(tmp, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "infrawrench"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    spawnSync("tar", ["-czf", path.join(release, asset), "-C", staging, "infrawrench"]);
    const hash = createHash("sha256")
      .update(readFileSync(path.join(release, asset)))
      .digest("hex");
    writeFileSync(path.join(release, "infrawrench-cli-SHA256SUMS"), sums ?? `${hash}  ${asset}\n`);
  }

  /**
   * `uname -s`/`-m` and `ldd --version` answer as `system`/`machine`/`libc`,
   * and `curl` copies the `file://` URL it is given (CI's shell environment
   * has no curl).
   */
  function stub(system: string, machine: string, libc = "GNU libc"): void {
    writeFileSync(
      path.join(stubs, "curl"),
      '#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && out="$2"; shift; done\ncp "${1#file://}" "$out"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(stubs, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(stubs, "ldd"), `#!/bin/sh\necho "ldd (${libc}) 2.39"\n`, {
      mode: 0o755,
    });
  }

  const install = () =>
    spawnSync("sh", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${stubs}:${process.env.PATH ?? ""}`,
        HOME: tmp,
        INFRAWRENCH_DOWNLOAD_BASE: `file://${release}`,
        INFRAWRENCH_INSTALL_DIR: bin,
      },
    });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "iw-install-"));
    release = path.join(tmp, "release");
    bin = path.join(tmp, "bin");
    stubs = path.join(tmp, "stubs");
    for (const dir of [release, stubs]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.each([
    ["Linux", "x86_64", "infrawrench-cli-linux-x64.tar.gz"],
    ["Linux", "aarch64", "infrawrench-cli-linux-arm64.tar.gz"],
    ["Darwin", "arm64", "infrawrench-cli-darwin-arm64.tar.gz"],
  ])("installs the %s %s build", (system, machine, asset) => {
    stub(system, machine);
    publish(asset);
    const result = install();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Installed infrawrench 1.2.3 to ${path.join(bin, "infrawrench")}`,
    );
    const installed = spawnSync(path.join(bin, "infrawrench"), { encoding: "utf8" });
    expect(installed.stdout.trim()).toBe("1.2.3");
  });

  it("refuses a download whose checksum does not match", () => {
    stub("Linux", "x86_64");
    publish(
      "infrawrench-cli-linux-x64.tar.gz",
      `${"0".repeat(64)}  infrawrench-cli-linux-x64.tar.gz\n`,
    );
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(path.join(bin, "infrawrench"))).toBe(false);
  });

  it("leaves the desktop app's shell command alone", () => {
    stub("Linux", "x86_64");
    publish("infrawrench-cli-linux-x64.tar.gz");
    mkdirSync(bin, { recursive: true });
    // What `electron/shell-command.ts` writes.
    const shim =
      "#!/bin/sh\n# Installed by Infrawrench. Launches the desktop app in CLI mode.\nexec x\n";
    writeFileSync(path.join(bin, "infrawrench"), shim);
    chmodSync(path.join(bin, "infrawrench"), 0o755);
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("desktop app's shell command");
    expect(readFileSync(path.join(bin, "infrawrench"), "utf8")).toBe(shim);
  });

  it("sends musl and unknown platforms to npm", () => {
    stub("Linux", "x86_64", "musl libc");
    expect(install().stderr).toContain("npm install -g @infrawrench/cli");
    stub("FreeBSD", "amd64");
    expect(install().stderr).toContain("npm install -g @infrawrench/cli");
  });
});
