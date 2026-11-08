/**
 * `kubectl exec -it <pod> -- /bin/sh` in a PTY, one stream per session
 * (`K8sExecOpen`); see `./k8s-pty.ts`.
 */
import type { K8sExecConfig } from "../shared/rpc/groups/k8s-local";
import { makeKubePtySessions } from "./k8s-pty";

export const k8sExecSessions = makeKubePtySessions<K8sExecConfig>({
  binary: "kubectl",
  tmpPrefix: "iw-k8s-",
  label: "kubectl exec",
  args: (config, kubeconfigPath) => [
    "exec",
    "-it",
    config.podName,
    ...(config.containerName ? ["-c", config.containerName] : []),
    "-n",
    config.namespace,
    "--kubeconfig",
    kubeconfigPath,
    "--",
    "/bin/sh",
  ],
});

export function killAllK8sExecs(): void {
  k8sExecSessions.killAll();
}
