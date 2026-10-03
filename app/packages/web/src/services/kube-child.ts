/**
 * The two things every kubectl / k9s child process on this server needs:
 * a kubeconfig file that has passed the server kubeconfig policy, and an
 * environment that carries nothing of ours.
 *
 * Both binaries honour `exec` credential plugins, `auth-provider`, file
 * paths and `proxy-url` in the kubeconfig, and this pod is shared by every
 * tenant, so the policy check comes before the file is even written. The
 * environment is explicit for the same reason: inheriting `process.env`
 * would hand the child (and anything it runs) the encryption master key,
 * the database URL and every other server secret.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertKubeconfigSafeForServer } from "@infrawrench/server-core/drivers";

export interface KubeconfigDir {
  tmpDir: string;
  kubeconfigPath: string;
}

/**
 * Validate `kubeconfig` and write it to a fresh private temp directory.
 * Throws (writing nothing) when the kubeconfig is not allowed here.
 */
export function writeServerKubeconfig(prefix: string, kubeconfig: string): KubeconfigDir {
  assertKubeconfigSafeForServer(kubeconfig);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
  return { tmpDir, kubeconfigPath };
}

/** Fallback when the server itself has no PATH (it always should). */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Minimal environment for a kubectl / k9s child. HOME and the XDG dirs
 * point into the session's temp dir, so kubectl's discovery cache and k9s's
 * config and state live and die with the session instead of being shared
 * between tenants.
 */
export function kubeChildEnv(dir: KubeconfigDir): Record<string, string> {
  return {
    PATH: process.env["PATH"] || DEFAULT_PATH,
    HOME: dir.tmpDir,
    TMPDIR: dir.tmpDir,
    XDG_CONFIG_HOME: path.join(dir.tmpDir, ".config"),
    XDG_CACHE_HOME: path.join(dir.tmpDir, ".cache"),
    XDG_STATE_HOME: path.join(dir.tmpDir, ".local", "state"),
    XDG_DATA_HOME: path.join(dir.tmpDir, ".local", "share"),
    KUBECONFIG: dir.kubeconfigPath,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
}
