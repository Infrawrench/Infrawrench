import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

// The archive is the one `rust-tar` in .github/workflows/desktop-build.yml packs:
// one static musl binary per Linux architecture, named `iwappd-<target triple>`,
// at the root of a tar.xz. Keep the two in step — a locally built archive laid out
// differently works on this machine and breaks everywhere else.
const TARGETS = [
  {
    triple: "x86_64-unknown-linux-musl",
    platform: "linux/amd64",
    // process.arch for the machine that can build this target without emulation.
    nativeArch: "x64",
  },
  {
    triple: "aarch64-unknown-linux-musl",
    platform: "linux/arm64",
    nativeArch: "arm64",
  },
];

// Alpine specifically, and the same tag CI uses: the compositor links libxkbcommon
// and a static build needs a musl build of it, which only Alpine packages
// (`libxkbcommon-static`). Debian and the cross images fail with `cannot find
// -lxkbcommon`. Each target is built on a container of its own architecture rather
// than cross-compiled, for the same reason — the static library has to be the
// target's.
const IMAGE = "alpine:3.22";

function docker(args, description) {
  const res = spawnSync("docker", args, { stdio: "inherit" });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      throw new Error(
        "iwappd needs to be compiled, but `docker` is not on PATH. Install Docker (or drop a prebuilt iwappd.tar.xz next to package.json, which is treated as externally managed).",
      );
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(
      `${description} failed (docker exited ${res.status ?? `on signal ${res.signal}`})`,
    );
  }
}

function assertDockerIsRunning() {
  const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (res.error?.code === "ENOENT") {
    throw new Error(
      "iwappd needs to be compiled, but `docker` is not on PATH. Install Docker (or drop a prebuilt iwappd.tar.xz next to package.json, which is treated as externally managed).",
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `iwappd needs to be compiled, but the Docker daemon is not reachable:\n${String(res.stderr ?? "").trim()}`,
    );
  }
}

function buildScript(triple) {
  // CARGO_TARGET_DIR is a named volume rather than linux-appserver/target: the two
  // architectures would otherwise share the host-compiled build scripts and proc
  // macros that live directly under the target dir, and the second build would link
  // the first one's. It also keeps root-owned artefacts out of the repository.
  return [
    "apk add --no-cache curl gcc musl-dev libxkbcommon-dev libxkbcommon-static file",
    // The volume survives between runs, so only the first build pays for rustup.
    // The toolchain itself comes from rust-toolchain.toml on the first cargo call.
    'if [ ! -x /root/.cargo/bin/cargo ]; then curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal; fi',
    "export PATH=/root/.cargo/bin:$PATH",
    "export CARGO_TARGET_DIR=/build",
    // --locked because /src is mounted read-only: without it a stale Cargo.lock
    // surfaces as a read-only filesystem error rather than "the lock file needs to
    // be updated".
    `cargo build --release --locked --target ${triple} -p iwappd`,
    `binary=/build/${triple}/release/iwappd`,
    'file "$binary"',
    // A dynamically linked "static" build only fails on the customer's host, days
    // later, so assert it here the way CI does.
    'if file "$binary" | grep -q "dynamically linked"; then echo "$binary is dynamically linked; it must be static to run on an unknown host" >&2; exit 1; fi',
    `install -D -m 0755 "$binary" /stage/bin/iwappd-${triple}`,
  ].join("\n");
}

function packScript(uid, gid) {
  return [
    // Alpine's stock tar is busybox's, which has neither --sort nor --owner; the
    // `tar` package replaces /bin/tar with GNU tar, and -J needs the xz binary.
    "apk add --no-cache tar xz",
    'tar --version | grep -q "GNU tar" || { echo "GNU tar is not on PATH" >&2; exit 1; }',
    "tar --numeric-owner --owner=0 --group=0 --sort=name -cJf /stage/iwappd.tar.xz -C /stage/bin .",
    // Written by root inside the container; hand it back so the host user can
    // replace it on the next build.
    `chown ${uid}:${gid} /stage/iwappd.tar.xz`,
    "ls -lh /stage/iwappd.tar.xz",
  ].join("\n");
}

/**
 * Compile iwappd for every Linux architecture the desktop app ships and write the
 * tar.xz the build expects to `xzFile`.
 *
 * Synchronous on purpose: the caller writes the hash file immediately afterwards, so
 * a rejected promise here would record a build that never happened.
 *
 * @param {string} xzFile absolute path the archive is written to
 * @param {string} appserverFolder absolute path to `linux-appserver/`
 */
export function dockerBuild(xzFile, appserverFolder) {
  // Building the foreign architecture costs minutes under emulation, which is rarely
  // what you want mid-`pnpm dev`. IWAPPD_TARGETS trims the archive to the triples
  // listed; the full set is what CI publishes and what a release needs.
  const only = process.env.IWAPPD_TARGETS?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const targets = only ? TARGETS.filter((t) => only.includes(t.triple)) : TARGETS;
  if (targets.length === 0) {
    throw new Error(
      `IWAPPD_TARGETS matched no known target. Known targets: ${TARGETS.map((t) => t.triple).join(", ")}`,
    );
  }

  assertDockerIsRunning();

  const stage = resolve(dirname(xzFile), ".iwappd-build");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  try {
    for (const target of targets) {
      if (target.nativeArch !== process.arch) {
        console.log(
          `Building iwappd for ${target.triple} under ${target.platform} emulation — this is slow. Set IWAPPD_TARGETS=${TARGETS.find((t) => t.nativeArch === process.arch)?.triple ?? ""} to skip it locally.`,
        );
      } else {
        console.log(`Building iwappd for ${target.triple}...`);
      }

      const cacheKey = target.platform.replace("/", "-");
      docker(
        [
          "run",
          "--rm",
          "--platform",
          target.platform,
          "-v",
          `${appserverFolder}:/src:ro`,
          "-v",
          `${stage}:/stage`,
          "-v",
          `iwappd-cargo-${cacheKey}:/root/.cargo`,
          "-v",
          `iwappd-rustup-${cacheKey}:/root/.rustup`,
          "-v",
          `iwappd-target-${target.triple}:/build`,
          "-w",
          "/src",
          IMAGE,
          "sh",
          "-euc",
          buildScript(target.triple),
        ],
        `iwappd build for ${target.triple}`,
      );
    }

    console.log("Packing iwappd.tar.xz...");
    docker(
      [
        "run",
        "--rm",
        "-v",
        `${stage}:/stage`,
        IMAGE,
        "sh",
        "-euc",
        packScript(process.getuid?.() ?? 0, process.getgid?.() ?? 0),
      ],
      "iwappd archive packing",
    );

    const packed = resolve(stage, "iwappd.tar.xz");
    if (!existsSync(packed)) {
      throw new Error(`iwappd archive packing produced no ${packed}`);
    }
    rmSync(xzFile, { force: true });
    renameSync(packed, xzFile);
    console.log(`Wrote ${xzFile}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
