// Stages the bundled extension and runs `vsce package` on the stage.
//
// The workspace manifest cannot be packaged as it stands: its name is the
// scoped `@infrawrench/vscode` (the Marketplace wants a bare name under a
// publisher) and it lists a `workspace:` dependency that vsce would try to
// resolve. The bundle already inlines that dependency, so the stage carries a
// manifest with the Marketplace name and no dependencies at all.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, "out", "stage");
rmSync(path.join(root, "out"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const staged = { ...manifest, name: "infrawrench" };
delete staged.private;
delete staged.dependencies;
delete staged.devDependencies;
staged.scripts = {};
writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

for (const entry of ["dist", "media", "README.md", "CHANGELOG.md"]) {
  cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
// The repository's licence, rather than a copy that could drift from it.
cpSync(path.join(root, "..", "..", "..", "LICENSE"), path.join(stage, "LICENSE.txt"));
// Source maps stay out of the shipped package.
rmSync(path.join(stage, "dist", "extension.js.map"), { force: true });
writeFileSync(path.join(stage, ".vscodeignore"), "**/*.map\n");

const require = createRequire(import.meta.url);
const vsce = require.resolve("@vscode/vsce/vsce");
const out = path.join(root, "out", `infrawrench-${manifest.version}.vsix`);
execFileSync(
  process.execPath,
  [vsce, "package", "--no-dependencies", "--allow-missing-repository", "--out", out],
  {
    cwd: stage,
    stdio: "inherit",
  },
);
console.log(`Packaged ${path.relative(root, out)}`);
