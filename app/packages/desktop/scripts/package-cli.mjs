// Packages the standalone CLI for this machine's platform: a Node single
// executable application (the running `node` with `out/cli/infrawrench.cjs`
// embedded, https://nodejs.org/api/single-executable-applications.html), its
// release archive, and on Linux a .deb for the APT repository.
//
//   node scripts/build-cli.mjs && node scripts/package-cli.mjs
//
// Output in out/cli/release/, with names that carry no version, so
// `releases/latest/download/<name>` is a stable URL for the install script
// (website/public/cli/install.sh):
//
//   infrawrench-cli-<os>-<arch>.tar.gz   (.zip on Windows), holding `infrawrench`
//   infrawrench-cli_<version>_<debarch>.deb   (Linux)
//
// Built natively per platform (desktop-build.yml's `cli-build` matrix) rather
// than cross-built: the blob then gets a V8 code cache, which only loads on
// the platform that compiled it, and macOS needs `codesign` anyway.
//
// Environment:
//   CLI_CODESIGN_IDENTITY  macOS signing identity (default "-", ad hoc)
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "out/cli");
const bundle = join(out, "infrawrench.cjs");
const work = join(out, "sea");
const release = join(out, "release");

// From the Node docs; postject flips its last character to mark the blob present.
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const POSTJECT = "postject@1.0.0-alpha.6";

const OS = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const ARCH = { x64: "x64", arm64: "arm64" }[process.arch];
const DEB_ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { stdio: "inherit", shell: false, ...options });
}

/**
 * postject's API, installed into out/cli/tools for this run. Not `npx
 * postject`: on Windows, npx under cmd installs the package and then cannot
 * find its `postject` command. Not a devDependency either: only release
 * runners need it.
 */
function loadPostject() {
  const tools = join(out, "tools");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(
    npm,
    [
      "install",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefix",
      tools,
      POSTJECT,
    ],
    // Node refuses to spawn a .cmd without a shell.
    { shell: process.platform === "win32" },
  );
  return createRequire(join(tools, "package.json"))("postject");
}

/** The executable: this `node`, with the bundle injected. */
async function buildExecutable(version) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const blob = join(work, "sea-prep.blob");
  const config = join(work, "sea-config.json");
  writeFileSync(
    config,
    JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        // Native build, so the cache is for the platform that runs it. The
        // bundle has no `import()` left (esbuild inlines them), which is
        // what a code cache cannot serve.
        useCodeCache: true,
      },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", config]);

  const exe = join(work, process.platform === "win32" ? "infrawrench.exe" : "infrawrench");
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
  const { inject } = loadPostject();
  console.log(`postject: injecting NODE_SEA_BLOB into ${exe}`);
  await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: SENTINEL,
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (process.platform === "darwin") {
    const identity = process.env.CLI_CODESIGN_IDENTITY || "-";
    run("codesign", ["--sign", identity, "--force", exe]);
  }

  // The executable has to answer like the bundle did, from a clean profile.
  const reported = execFileSync(exe, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, INFRAWRENCH_CONFIG_DIR: join(work, "profile") },
  }).trim();
  if (reported !== version) {
    throw new Error(`package-cli: the executable reports ${reported}, expected ${version}`);
  }
  return exe;
}

/** The executable beside its licences: the repository's and the bundled packages'. */
function archive(exe) {
  mkdirSync(release, { recursive: true });
  copyFileSync(resolve(root, "../../../LICENSE"), join(work, "LICENSE"));
  copyFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), join(work, "THIRD_PARTY_LICENSES.txt"));
  const members = [basename(exe), "LICENSE", "THIRD_PARTY_LICENSES.txt"];
  const name = `infrawrench-cli-${OS}-${ARCH}`;
  if (process.platform === "win32") {
    // Windows' own bsdtar writes a zip for `-a` and a .zip name. By path:
    // under Git Bash, `tar` is GNU tar, which would write a tar named .zip.
    const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const file = join(release, `${name}.zip`);
    run(bsdtar, ["-a", "-c", "-f", file, "-C", work, ...members]);
    return file;
  }
  const file = join(release, `${name}.tar.gz`);
  run("tar", ["-czf", file, "-C", work, ...members]);
  return file;
}

/** `/usr/bin/infrawrench` in a .deb, for the APT repository the desktop .deb is in. */
function debian(exe, version) {
  const pkg = join(work, "deb");
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(pkg, "DEBIAN"), { recursive: true });
  mkdirSync(join(pkg, "usr/bin"), { recursive: true });
  mkdirSync(join(pkg, "usr/share/doc/infrawrench-cli"), { recursive: true });
  copyFileSync(exe, join(pkg, "usr/bin/infrawrench"));
  chmodSync(join(pkg, "usr/bin/infrawrench"), 0o755);
  const doc = join(pkg, "usr/share/doc/infrawrench-cli");
  copyFileSync(resolve(root, "../../../LICENSE"), join(doc, "copyright"));
  copyFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), join(doc, "THIRD_PARTY_LICENSES.txt"));
  writeFileSync(
    join(pkg, "DEBIAN/control"),
    [
      "Package: infrawrench-cli",
      `Version: ${version}`,
      `Architecture: ${DEB_ARCH}`,
      "Maintainer: Infrawrench Services, Inc. <astrid@infrawrench.com>",
      "Homepage: https://infrawrench.com/docs/features/cli",
      "Section: utils",
      "Priority: optional",
      // Node's official Linux builds need glibc 2.28 or newer.
      "Depends: libc6 (>= 2.28)",
      "Description: Infrawrench command-line interface",
      " The infrawrench command without the desktop app: costs, resources,",
      " dashboards, environment files and the rest of Infrawrench Cloud from",
      " a terminal, a CI job or a server.",
      "",
    ].join("\n"),
  );
  const file = join(release, `infrawrench-cli_${version}_${DEB_ARCH}.deb`);
  run("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", pkg, file]);
  return file;
}

if (!OS || !ARCH)
  throw new Error(`package-cli: unsupported platform ${process.platform}-${process.arch}`);
if (!existsSync(bundle)) throw new Error("package-cli: run scripts/build-cli.mjs first");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const exe = await buildExecutable(version);
const files = [archive(exe)];
if (process.platform === "linux") files.push(debian(exe, version));
for (const file of files) console.log(`package-cli: ${file}`);
