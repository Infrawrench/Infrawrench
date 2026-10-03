import https from "node:https";
import http from "node:http";
import { ipcMain } from "electron";
import { z } from "zod";
import { killK8sExec, resizeK8sExec, spawnK8sExec, writeK8sExec } from "./k8s-exec";
import { checkK9sInstalled, killK9s, resizeK9s, spawnK9s, writeK9s } from "./k9s";
import { startPortForward, stopPortForward } from "./k8s-port-forward";
import { resolveK8sApiEndpoint } from "./k8s-endpoints";
import { localExecGuard } from "./local-exec-consent";
import { isCredentialEndpoint } from "./cors-policy";

// Everything below lands on a kubectl/k9s command line. Kubernetes object
// names never start with "-", so refusing that keeps a renderer-supplied
// name from being read as a flag (`--kubeconfig=...`), and the kubeconfig is
// vetted by the local-exec consent gate before it is written to disk.
const K8sName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "not a valid Kubernetes name");
const Kubeconfig = z
  .string()
  .min(1)
  .max(256 * 1024);
const TermSize = z.number().int().min(1).max(1000);

const K8sExecArgs = z.object({
  kubeconfig: Kubeconfig,
  namespace: K8sName,
  podName: K8sName,
  containerName: K8sName.optional(),
  cols: TermSize,
  rows: TermSize,
});
const K9sArgs = z.object({
  kubeconfig: Kubeconfig,
  namespace: K8sName.optional(),
  cols: TermSize,
  rows: TermSize,
});
const PortForwardArgs = z.object({
  kubeconfig: Kubeconfig,
  namespace: K8sName,
  resourceType: z.enum(["svc", "pod", "deploy"]),
  resourceName: K8sName,
  remotePort: z.number().int().min(1).max(65535),
  localPort: z.number().int().min(0).max(65535).optional(),
});

ipcMain.handle("k8s_exec_spawn", async (event, raw: unknown) => {
  const args = K8sExecArgs.parse(raw);
  await localExecGuard.assertKubeconfig(args.kubeconfig);
  return spawnK8sExec(event.sender, args);
});
ipcMain.handle("k8s_exec_write", (_event, { sessionId, data }) => writeK8sExec(sessionId, data));
ipcMain.handle("k8s_exec_resize", (_event, { sessionId, cols, rows }) =>
  resizeK8sExec(sessionId, cols, rows),
);
ipcMain.handle("k8s_exec_kill", (_event, { sessionId }) => killK8sExec(sessionId));

ipcMain.handle("k9s_check", () => checkK9sInstalled());
ipcMain.handle("k9s_spawn", async (event, raw: unknown) => {
  const args = K9sArgs.parse(raw);
  await localExecGuard.assertKubeconfig(args.kubeconfig);
  return spawnK9s(event.sender, args);
});
ipcMain.handle("k9s_write", (_event, { sessionId, data }) => writeK9s(sessionId, data));
ipcMain.handle("k9s_resize", (_event, { sessionId, cols, rows }) =>
  resizeK9s(sessionId, cols, rows),
);
ipcMain.handle("k9s_kill", (_event, { sessionId }) => killK9s(sessionId));

ipcMain.handle("k8s_pf_start", async (event, raw: unknown) => {
  const args = PortForwardArgs.parse(raw);
  await localExecGuard.assertKubeconfig(args.kubeconfig);
  return startPortForward(event.sender, args);
});
ipcMain.handle("k8s_pf_stop", (_event, { sessionId }) => stopPortForward(sessionId));

// Routed through Node so we can supply the cluster CA cert; Chromium's fetch
// won't trust per-request CAs.

interface K8sApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string; // PEM-encoded CA certificate
}

ipcMain.handle(
  "k8s_api_request",
  (
    _event,
    req: K8sApiRequest,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      return Promise.reject(new Error("k8s_api_request: invalid URL"));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return Promise.reject(
        new Error(`k8s_api_request: scheme "${parsed.protocol}" not permitted`),
      );
    }
    const isHttps = parsed.protocol === "https:";
    const port = parsed.port || (isHttps ? "443" : "80");

    // SSRF defense: see k8s-endpoints.ts for the allowlist trust model. The
    // name is resolved once, every address is vetted, and the connection is
    // pinned to the vetted address so a second lookup cannot answer
    // differently.
    return resolveK8sApiEndpoint(parsed.hostname, port, {
      trusted: isCredentialEndpoint(parsed.hostname, port),
    })
      .catch((err: unknown) => {
        throw new Error(
          `k8s_api_request: ${err instanceof Error ? err.message : String(err)}. ` +
            `Add the cluster via your kubeconfig to allowlist it.`,
        );
      })
      .then(
        (pinned) =>
          new Promise((resolve, reject) => {
            const mod = isHttps ? https : http;

            const options: https.RequestOptions = {
              hostname: parsed.hostname,
              port: parsed.port || (isHttps ? 443 : 80),
              path: parsed.pathname + parsed.search,
              method: req.method,
              headers: req.headers,
              lookup: (_hostname, opts, callback) => {
                if ((opts as { all?: boolean }).all) {
                  (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(
                    null,
                    [pinned],
                  );
                } else {
                  callback(null, pinned.address, pinned.family);
                }
              },
            };

            if (isHttps && req.caCert) {
              options.ca = req.caCert;
            }

            const nodeReq = mod.request(options, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                  if (v == null) continue;
                  headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
                }
                resolve({
                  status: res.statusCode ?? 0,
                  headers,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
            });

            nodeReq.on("error", (err) => reject(err));
            nodeReq.setTimeout(30_000, () => {
              nodeReq.destroy(new Error("K8s API request timed out (30s)"));
            });

            if (req.body) nodeReq.write(req.body);
            nodeReq.end();
          }),
      );
  },
);
