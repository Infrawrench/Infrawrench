// rolldown-plugin-dts (via tsdown) emits declarations with the native compiler only when
// `require("typescript").versionMajorMinor` is "7.0", and it accepts `typescript` ~7.0.0 as a
// peer. tsc-rs reports "7.1" (the upstream revision it ports), so it reads the real TypeScript 7
// package's version here; the binary that actually runs is chosen in getExePath.js.
module.exports = require("typescript");
