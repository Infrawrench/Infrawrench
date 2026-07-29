// Entry bootstrap. `--cli` (passed by the `infrawrench` shell shim, or by
// hand) routes into the headless CLI runner; anything else boots the GUI.
// Both paths are dynamically imported so a CLI invocation never executes the
// GUI's import-time side effects (protocol registration, single-instance
// lock, IPC handler setup) and the GUI never pulls in the CLI.
if (process.argv.includes("--cli")) {
  // Dependency deprecation warnings (e.g. the mongodb driver's tr46 requiring
  // node's deprecated `punycode`) would print into the user's terminal before
  // any CLI output. They are ours to fix, not the user's to read — silence
  // them before the import chain below loads the offending modules.
  process.noDeprecation = true;
  void import("./cli/main.js").then((m) => m.runCli());
} else {
  void import("./main.js");
}
