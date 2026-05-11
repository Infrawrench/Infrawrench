import https from "node:https";
import http from "node:http";
import net from "node:net";
import { ipcMain } from "electron";
import { killK8sExec, resizeK8sExec, spawnK8sExec, writeK8sExec } from "./k8s-exec";
import { checkK9sInstalled, killK9s, resizeK9s, spawnK9s, writeK9s } from "./k9s";
import { startPortForward, stopPortForward, listPortForwards } from "./k8s-port-forward";

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
ipcMain.handle("k8s_pf_list", () => listPortForwards());

// Routes K8s API requests through Node so we can supply the cluster CA cert
// that Chromium's fetch() refuses to trust.

interface K8sApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  caCert?: string; // PEM-encoded CA certificate
}

/**
 * Hosts that an attacker-controlled renderer could try to abuse for SSRF.
 *
 * `k8s_api_request` is meant to talk to Kubernetes API servers that the user
 * has configured in their kubeconfig — which in practice are remote hostnames.
 * If a request targets a loopback/private/link-local address, we require the
 * host:port to have been registered by a kubeconfig-driven caller (see
 * `registerK8sEndpoint` below) — otherwise we refuse.
 *
 * This blocks XSS-driven scans of cloud metadata services (169.254.169.254),
 * the local Docker daemon, internal corporate services, etc.
 */
const REGISTERED_K8S_HOSTS = new Set<string>();

export function registerK8sEndpoint(host: string, port: number | string): void {
  REGISTERED_K8S_HOSTS.add(`${host.toLowerCase()}:${port}`);
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "metadata.google.internal") return true;
  // IPv4 numeric checks
  if (net.isIPv4(lower)) {
    const [a = 0, b = 0] = lower.split(".").map((p) => Number(p));
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6 — block loopback, ULA, link-local
  if (net.isIPv6(lower)) {
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return false;
}

ipcMain.handle(
  "k8s_api_request",
  (_event, req: K8sApiRequest): Promise<{ status: number; body: string }> => {
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
      const endpointKey = `${parsed.hostname.toLowerCase()}:${port}`;

      // Block private/loopback/link-local targets unless explicitly registered
      // by the cluster-config loader. Today that registration list is empty —
      // legitimate users mostly talk to public Kubernetes endpoints, and any
      // local-cluster (kind, minikube, k3d) traffic should run through the
      // k8s plugin's local-config path, not `k8s_api_request`. If we later
      // want to support those, call `registerK8sEndpoint` from kubeconfig
      // ingestion.
      if (isPrivateOrLoopbackHost(parsed.hostname) && !REGISTERED_K8S_HOSTS.has(endpointKey)) {
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

      // FIX_FLAG: the renderer still supplies the CA cert per call. Long-term
      // this should be loaded from main-side cluster config keyed by hostname
      // — see `registerK8sEndpoint`. For now we accept the CA but only after
      // confirming the URL points at a permitted host above.
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
      nodeReq.setTimeout(30_000, () => {
        nodeReq.destroy(new Error("K8s API request timed out (30s)"));
      });

      if (req.body) nodeReq.write(req.body);
      nodeReq.end();
    });
  },
);
