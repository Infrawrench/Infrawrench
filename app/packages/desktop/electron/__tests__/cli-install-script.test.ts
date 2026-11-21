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
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "../../../website/public/cli/install.sh");

/**
 * Installing extracts the archive with `tar -xz`, which needs `tar` and
 * `gzip` on PATH. Infrawrench CI's `env:bash-node@24.0.18` has neither (they
 * arrived in 24.0.22), so the install cases run where both exist and the
 * refusals, which never extract, run everywhere.
 */
const HAS_TAR = ["tar", "gzip"].every(
  (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0,
);

/** One regular file as a POSIX ustar archive. */
function tarball(name: string, content: string, mode: number): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  const field = (offset: number, length: number, value: string) =>
    header.write(value, offset, length, "ascii");
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0");
  field(0, 100, name);
  field(100, 8, octal(mode, 8));
  field(108, 8, octal(0, 8));
  field(116, 8, octal(0, 8));
  field(124, 12, octal(data.length, 12));
  field(136, 12, octal(Math.floor(Date.now() / 1000), 12));
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 6, "ustar");
  field(263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${octal(sum, 7)}\0`);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let tmp: string;
  let release: string;
  let bin: string;
  let stubs: string;

  /**
   * A fake `infrawrench` packed the way `package-cli.mjs` packs the real one.
   * Packed here rather than with `tar`, so the cases that never extract it
   * need no `tar` either.
   */
  function publish(asset: string, sums?: string): void {
    const archive = gzipSync(tarball("infrawrench", "#!/bin/sh\necho 1.2.3\n", 0o755));
    writeFileSync(path.join(release, asset), archive);
    const hash = createHash("sha256").update(archive).digest("hex");
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
  ])("installs the %s %s build", { skip: !HAS_TAR }, (system, machine, asset) => {
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
