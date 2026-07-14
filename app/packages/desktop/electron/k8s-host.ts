import https from "node:https";
import http from "node:http";
import { ipcMain } from "electron";
import { killK8sExec, resizeK8sExec, spawnK8sExec, writeK8sExec } from "./k8s-exec";
import { checkK9sInstalled, killK9s, resizeK9s, spawnK9s, writeK9s } from "./k9s";
import { startPortForward, stopPortForward } from "./k8s-port-forward";
import { isK8sApiEndpointAllowed } from "./k8s-endpoints";

ipcMain.handle("k8s_exec_spawn", (event, args) => spawnK8sExec(event.sender, args));
ipcMain.handle("k8s_exec_write", (_event, { sessionId, data }) => writeK8sExec(sessionId, data));
ipcMain.handle("k8s_exec_resize", (_event, { sessionId, cols, rows }) =>
  resizeK8sExec(sessionId, cols, rows),
);
ipcMain.handle("k8s_exec_kill", (_event, { sessionId }) => killK8sExec(sessionId));

ipcMain.handle("k9s_check", () => checkK9sInstalled());
ipcMain.handle("k9s_spawn", (event, args) => spawnK9s(event.sender, args));
ipcMain.handle("k9s_write", (_event, { sessionId, data }) => writeK9s(sessionId, data));
ipcMain.handle("k9s_resize", (_event, { sessionId, cols, rows }) =>
  resizeK9s(sessionId, cols, rows),
);
ipcMain.handle("k9s_kill", (_event, { sessionId }) => killK9s(sessionId));

ipcMain.handle("k8s_pf_start", (event, args) => startPortForward(event.sender, args));
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
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch {
        reject(new Error("k8s_api_request: invalid URL"));
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        reject(new Error(`k8s_api_request: scheme "${parsed.protocol}" not permitted`));
        return;
      }
      const isHttps = parsed.protocol === "https:";
      const port = parsed.port || (isHttps ? "443" : "80");

      // SSRF defense — see k8s-endpoints.ts for the allowlist trust model.
      if (!isK8sApiEndpointAllowed(parsed.hostname, port)) {
        reject(
          new Error(
            `k8s_api_request: refused private/loopback host "${parsed.hostname}". ` +
              `Add the cluster via your kubeconfig to allowlist it.`,
          ),
        );
        return;
      }

      const mod = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: req.headers,
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
    });
  },
);
