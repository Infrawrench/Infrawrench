// Entry bootstrap. `--cli` (passed by the `infrawrench` shell shim, or by
// hand) routes into the headless CLI runner; anything else boots the GUI.
// Both paths are dynamically imported so a CLI invocation never executes the
// GUI's import-time side effects (protocol registration, single-instance
// lock, IPC handler setup) and the GUI never pulls in the CLI.

// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { app } from "electron";
import { markPhase } from "./startup-timing";

markPhase("main entry");
if (process.argv.includes("--cli")) {
  // Terminal process: no Dock icon, no GPU. The packaged macOS app declares
  // `LSUIElement` (package.json `mac.extendInfo`), so it starts as an
  // accessory app with no Dock icon or menu bar, and a CLI run never shows
  // one. Hiding here, before anything else runs and before the app finishes
  // launching, is for the unpackaged dev binary, which has no such key: this
  // early it never registers as a foreground app, where hiding after the
  // CLI's modules load left a Dock icon up for most of a second.
  if (process.platform === "darwin") app.dock?.hide();
  app.commandLine.appendSwitch("disable-gpu");
  // Dependency deprecation warnings (e.g. the mongodb driver's tr46 requiring
  // node's deprecated `punycode`) would print into the user's terminal before
  // any CLI output. They are ours to fix, not the user's to read: silence
  // them before the import chain below loads the offending modules.
  process.noDeprecation = true;
  void import("./cli/main.js").then((m) => m.runCli());
} else {
  // `LSUIElement` makes every launch an accessory app; the GUI is a regular
  // one (Dock icon, menu bar, Cmd-Tab). Switching before the app finishes
  // launching makes it behave exactly as if the key were absent: set later,
  // macOS can leave the menu bar unresponsive until the app is reactivated.
  // A no-op where the key is absent (dev, Windows and Linux have no policy).
  if (process.platform === "darwin") app.setActivationPolicy("regular");
  void import("./main.js");
}
