// The native `tsc` this package runs. rolldown-plugin-dts loads `<typescript>/lib/getExePath.js`
// to find the compiler it spawns for declaration emit, and bin/tsc.js uses it for every
// `tsc` in a package script, so both go through tsc-rs.
//
// tsc-rs ships binaries for linux-x64, linux-arm64 and darwin-arm64 only. Elsewhere (Windows,
// Intel macOS) its getExePath throws and this falls back to TypeScript 7's own binary, which
// gives the same diagnostics. INFRAWRENCH_TSC=typescript forces that fallback, for comparing the
// two when a result looks wrong.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Neither package exports lib/getExePath.js, so load it by file path. Both are synchronous ESM,
// which require() loads.
function upstream(pkg) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return require(path.join(dir, "lib", "getExePath.js")).default;
}

export default function getExePath() {
  if (process.env.INFRAWRENCH_TSC !== "typescript") {
    try {
      return upstream("tsc-rs")();
    } catch {
      // No tsc-rs binary for this platform.
    }
  }
  return upstream("typescript")();
}
