// What a desktop-only module is in the standalone CLI.
//
// `scripts/build-cli.mjs` resolves every module in `DESKTOP_ONLY_MODULES`
// here: the local workspace (`local-*.ts`, `plugin-runtime.ts`, the plugin
// loader) and the parts that drive the desktop app (the shell shim, SSH
// tunnels, the Linux app server archive). Leaving them out is what keeps every
// provider SDK out of the bundle. The CLI never reaches them there: `--local`
// is refused, no "Local" scope is listed, and the desktop-only commands are
// not loaded (`../edition.ts`). If something does, each export is a function
// that throws, so the failure says what is missing rather than crashing on load.
//
// CommonJS on purpose: esbuild checks an ES module's named imports against its
// exports at build time, and a CommonJS module's exports are only known at run
// time, so this one file can stand in for modules with different exports.
"use strict";

const message =
  "This needs the Infrawrench desktop app. The standalone CLI works with your Infrawrench Cloud organizations.";

function unavailable() {
  const error = new Error(message);
  error.name = "UserFacingError";
  throw error;
}

module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "__esModule") return true;
      if (typeof key !== "string") return undefined;
      return unavailable;
    },
  },
);
