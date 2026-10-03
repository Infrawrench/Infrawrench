/**
 * The GUI's instance of the local-execution consent gate (see
 * local-exec-guard.ts): stored values come from the encrypted accounts table
 * and consent is a native dialog. GUI-only: the CLI never goes through
 * renderer IPC, so it never imports this.
 *
 * Which credentials count is decided by key name, not by the account's
 * `plugin_id`: the renderer can rewrite that column through `db_execute`, so
 * binding to it would let a value saved under an unguarded plugin be rebound
 * to the Kubernetes or Docker plugin afterwards. Any key that some bundled
 * manifest declares as its Kubernetes or Docker driver credential is gated on
 * every account, whatever plugin the account claims to be.
 */
import { BrowserWindow, dialog } from "electron";
import { loadPlugins } from "../src/plugins/loader";
import { getSqlite } from "./db";
import { getAccountCredentials } from "./plugin-runtime";
import { getActiveTunnels } from "./ssh-tunnel";
import { createLocalExecGuard, type ConsentRequest, type GuardedKind } from "./local-exec-guard";

/** Credential keys bundled manifests declare for each guarded driver. */
async function guardedKeys(kind: GuardedKind): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const { plugin } of await loadPlugins()) {
    const key =
      kind === "kubeconfig"
        ? plugin.manifest.kubernetesDriver?.credentialKey
        : plugin.manifest.dockerDriver?.credentialKey;
    if (key) keys.add(key);
  }
  return keys;
}

async function storedValues(kind: GuardedKind): Promise<string[]> {
  const keys = await guardedKeys(kind);
  const db = await getSqlite();
  const stmt = db.prepare("SELECT id FROM accounts");
  const ids: string[] = [];
  while (stmt.step()) ids.push(String((stmt.getAsObject() as Record<string, unknown>)["id"]));
  stmt.free();
  const values: string[] = [];
  for (const id of ids) {
    let credentials: Record<string, string>;
    try {
      credentials = await getAccountCredentials(id);
    } catch {
      continue; // An undecryptable row matches nothing.
    }
    for (const key of keys) {
      // Only explicitly stored values: an absent Docker host means the local
      // default socket, and no account should vouch for that by omission.
      const value = credentials[key];
      if (typeof value === "string" && value.trim() !== "") values.push(value);
    }
  }
  return values;
}

function dialogText(request: ConsentRequest): { message: string; detail: string } {
  const listing = request.summary.join("\n");
  if (request.kind === "kubeconfig") {
    return {
      message:
        request.purpose === "save"
          ? "Save a kubeconfig that runs a program on this computer?"
          : "Let this Kubernetes connection run a program on this computer?",
      detail:
        "This kubeconfig authenticates by running a local command:\n\n" +
        `${listing}\n\n` +
        "Only allow this if you added this cluster yourself and recognise the command. " +
        "If you did not just add or open a Kubernetes cluster, choose Cancel.",
    };
  }
  return {
    message:
      request.purpose === "save"
        ? "Save an account that controls a Docker engine?"
        : "Let Infrawrench control this Docker engine?",
    detail:
      `${listing}\n\n` +
      "Only allow this if you added this Docker host yourself. " +
      "If you did not just add or open a Docker account, choose Cancel.",
  };
}

async function confirm(request: ConsentRequest): Promise<boolean> {
  const { message, detail } = dialogText(request);
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancel", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Infrawrench",
    message,
    detail,
  };
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

export const localExecGuard = createLocalExecGuard({
  storedValues,
  activeTunnelPorts: () => Object.values(getActiveTunnels()).map((t) => t.localPort),
  confirm,
});

/**
 * Gate an account write: every guarded value is compared with what the
 * account held before, and a new or changed one needs consent.
 */
export async function approveAccountCredentials(
  next: Record<string, string>,
  previous: Record<string, string> | undefined,
): Promise<void> {
  const entries: Array<{ kind: GuardedKind; next: string; previous: string | undefined }> = [];
  for (const kind of ["kubeconfig", "dockerHost"] as const) {
    for (const key of await guardedKeys(kind)) {
      const value = next[key];
      if (value === undefined || value.trim() === "") continue;
      entries.push({ kind, next: value, previous: previous?.[key] });
    }
  }
  await localExecGuard.approveForStorage(entries);
}
