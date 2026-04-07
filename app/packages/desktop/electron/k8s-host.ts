import https from "node:https";
import http from "node:http";
import { ipcMain } from "electron";
import { killK8sExec, resizeK8sExec, spawnK8sExec, writeK8sExec } from "./k8s-exec";
import { checkK9sInstalled, killK9s, resizeK9s, spawnK9s, writeK9s } from "./k9s";

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

// ── K8s API proxy ────────────────────────────────────────────────────────────
// Routes K8s API requests through Node so we can supply the cluster CA cert
// that Chromium's fetch() refuses to trust.

interface K8sApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  caCert?: string; // PEM-encoded CA certificate
}

ipcMain.handle(
  "k8s_api_request",
  (_event, req: K8sApiRequest): Promise<{ status: number; body: string }> => {
    return new Promise((resolve, reject) => {
      const parsed = new URL(req.url);
      const isHttps = parsed.protocol === "https:";
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
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      nodeReq.on("error", (err) => reject(err));

      if (req.body) nodeReq.write(req.body);
      nodeReq.end();
    });
  },
);
