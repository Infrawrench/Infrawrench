/**
 * k9s in a PTY, one stream per session (`K9sOpen`); see `./k8s-pty.ts`.
 */
import type { K9sConfig } from "../shared/rpc/groups/k8s-local";
import { makeKubePtySessions } from "./k8s-pty";
import { ensureNodePtySpawnHelperExecutable, resolveBinaryPath } from "./pty";

export function checkK9sInstalled(): boolean {
  try {
    ensureNodePtySpawnHelperExecutable();
    resolveBinaryPath("k9s");
    return true;
  } catch {
    return false;
  }
}

export const k9sSessions = makeKubePtySessions<K9sConfig>({
  binary: "k9s",
  tmpPrefix: "iw-k9s-",
  label: "k9s",
  args: (config, kubeconfigPath) => [
    "--kubeconfig",
    kubeconfigPath,
    ...(config.namespace ? ["-n", config.namespace] : []),
  ],
});

export function killAllK9sSessions(): void {
  k9sSessions.killAll();
}
