// The native `tsc` this package runs. rolldown-plugin-dts loads `<typescript>/lib/getExePath.js`
// to find the compiler it spawns for declaration emit, and bin/tsc.js uses it for every
// `tsc` in a package script, so both go through tsc-rs.
//
// tsc-rs ships binaries for linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64 and
// win32-arm64. Anywhere else its getExePath throws and this falls back to TypeScript 7's own
// binary, which gives the same diagnostics. INFRAWRENCH_TSC=typescript forces that fallback, for
// comparing the two when a result looks wrong.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Neither package exports lib/getExePath.js, so load it by file path. Both are synchronous ESM,
// which require() loads.
function upstream(pkg) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return require(path.join(dir, "lib", "getExePath.js")).default;
}

/** @returns {{ exe: string, compiler: "tsc-rs" | "typescript" }} */
export function chooseCompiler() {
  if (process.env.INFRAWRENCH_TSC !== "typescript") {
    try {
      return { exe: upstream("tsc-rs")(), compiler: "tsc-rs" };
    } catch {
      // No tsc-rs binary for this platform.
    }
  }
  return { exe: upstream("typescript")(), compiler: "typescript" };
}

export default function getExePath() {
  return chooseCompiler().exe;
}
