// Entry bootstrap. `--cli` (passed by the `infrawrench` shell shim, or by
// hand) routes into the headless CLI runner; anything else boots the GUI.
// Both paths are dynamically imported so a CLI invocation never executes the
// GUI's import-time side effects (protocol registration, single-instance
// lock, IPC handler setup) and the GUI never pulls in the CLI.
if (process.argv.includes("--cli")) {
  void import("./cli/main.js").then((m) => m.runCli());
} else {
  void import("./main.js");
}
