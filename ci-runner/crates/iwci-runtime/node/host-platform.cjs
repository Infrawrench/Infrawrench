// A `node` of a workspace installed with the runner's own Linux packages
// (`deps: [{ pnpm: { native: true } }]`) reports that platform, as Node on
// the runner would: `process.platform` and `process.arch` (and so
// `os.platform()` and `os.arch()`, which read them) say `linux` and `x64`
// or `arm64`, not Edge.js's `wasi` and `wasm32`, from IWCI_NODE_PLATFORM,
// which the installer sets for such a workspace's jobs, or, when a tool
// started this `node` without it (turbo runs its tasks with only the
// variables they name), from /etc/iwci/node-platform, which the workspace
// writes beside it.
//
// That is what a package's wrapper looks at to choose its platform build:
// turbo's `bin/turbo` runs `turbo-linux-64/bin/turbo`, sherif's
// `sherif-linux-x64`, and the job's `node` starts it, natively in the
// sandbox (`tools: [builtin:glibc@2.39]`) or, outside it, with a message
// that says the job needs the sandbox. A native addon (`.node`) still
// cannot load into Edge.js: napi-rs packages fall back to their
// `wasm32-wasi` build when it fails, as they do for `wasi` today.
"use strict";

function platform() {
  const set = process.env.IWCI_NODE_PLATFORM;
  if (set !== undefined) return set;
  try {
    return require("fs").readFileSync("/etc/iwci/node-platform", "utf8").trim();
  } catch {
    return "";
  }
}

const value = platform();
const match = /^(linux)-(x64|arm64)$/.exec(value);
if (match) {
  for (const [name, reported] of [
    ["platform", match[1]],
    ["arch", match[2]],
  ]) {
    Object.defineProperty(process, name, {
      value: reported,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }
}
