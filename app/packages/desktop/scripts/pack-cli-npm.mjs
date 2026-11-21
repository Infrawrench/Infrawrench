// Packs the standalone CLI as the npm package `@infrawrench/cli`
// (the manifest and README are `npm/`), at the desktop app's version, into
// out/cli/npm/. desktop-build.yml publishes the tarball this writes, so what
// npm serves is the bundle the release was built and tested from.
//
//   node scripts/build-cli.mjs && node scripts/pack-cli-npm.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "out/cli");
const stage = join(out, "npm-package");
const dest = join(out, "npm");

for (const file of ["infrawrench.cjs", "THIRD_PARTY_LICENSES.txt"]) {
  if (!existsSync(join(out, file)))
    throw new Error(`pack-cli-npm: run scripts/build-cli.mjs first (${file})`);
}
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "npm/package.json"), "utf8"));
manifest.version = version;
for (const field of [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
]) {
  if (manifest[field])
    throw new Error(`pack-cli-npm: npm/package.json has ${field}; the bundle carries everything`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(resolve(root, "npm/README.md"), join(stage, "README.md"));
copyFileSync(resolve(root, "../../../LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(out, "infrawrench.cjs"), join(stage, "infrawrench.cjs"));
copyFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), join(stage, "THIRD_PARTY_LICENSES.txt"));

const reported = execFileSync(process.execPath, [join(stage, "infrawrench.cjs"), "--version"], {
  encoding: "utf8",
}).trim();
if (reported !== version)
  throw new Error(`pack-cli-npm: the bundle reports ${reported}, expected ${version}`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = execFileSync(npm, ["pack", "--json", "--pack-destination", dest], {
  cwd: stage,
  encoding: "utf8",
  shell: process.platform === "win32",
});
const [{ filename, files }] = JSON.parse(packed);
const names = files.map((f) => f.path).sort();
for (const required of [
  "infrawrench.cjs",
  "package.json",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_LICENSES.txt",
]) {
  if (!names.includes(required)) throw new Error(`pack-cli-npm: the tarball has no ${required}`);
}
console.log(`pack-cli-npm: ${join(dest, filename)} (${names.join(", ")})`);
