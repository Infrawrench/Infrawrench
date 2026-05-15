/**
 * Hono API server + Vite SPA dev middleware + WebSocket support
 * for SSH terminals, SQL query proxy, and K8s exec sessions.
 */
import { createServer as createHttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { parse } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { api } from "./src/api/index";
import { handleSshSession } from "./src/services/ssh-proxy";
import { handleSqlSession } from "./src/services/sql-proxy";
import { handleK8sExecSession } from "./src/services/k8s-exec-proxy";
import { handleK9sSession } from "./src/services/k9s-proxy";
import { handleK8sPfSession } from "./src/services/k8s-pf-proxy";
import { resolveKubeconfig } from "./src/services/k8s-kubeconfig-resolver";
import { authenticateApiRequest } from "./src/auth/api-auth";
import { validateWsToken } from "./src/services/ws-tokens";
import { handleMcpHttp } from "./src/mcp/http-handler";
import { migrateMetrics } from "@infrawrench/server-core/clickhouse/migrate";
import { authenticateBastionAgent, handleBastionAgentUpgrade } from "./src/services/bastion-ws";

const dev = process.env["NODE_ENV"] !== "production";
const port = parseInt(process.env["PORT"] ?? "3000", 10);

async function start() {
  try {
    await migrateMetrics();
  } catch (err) {
    console.error("[clickhouse] migrateMetrics failed:", err);
    if (!dev) throw err;
  }

  const honoListener = getRequestListener(api.fetch);
  let server: ReturnType<typeof createHttpServer>;

  if (dev) {
    // In dev: Vite dev server in middleware mode, Hono for API routes
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    // Route at the Node.js HTTP level: API/callback/well-known → Hono,
    // /api/mcp → MCP transport, everything else → Vite
    server = createHttpServer((req, res) => {
      const url = req.url ?? "";
      const path = url.split("?", 1)[0] ?? "";
      if (path === "/api/mcp") {
        void handleMcpHttp(req, res).catch((e) => {
          console.error("[mcp] handler error:", e);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Internal MCP error" }));
          }
        });
      } else if (
        url.startsWith("/api/") ||
        url.startsWith("/callback") ||
        url.startsWith("/.well-known/")
      ) {
        honoListener(req, res);
      } else {
        vite.middlewares(req, res);
      }
    });
    server.listen(port);
  } else {
    // In prod: serve static files from dist/client/ via Hono
    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { Hono } = await import("hono");
    const prodApp = new Hono();

    prodApp.route("/", api);
    prodApp.use("*", serveStatic({ root: "./dist/client" }));
    // SPA fallback: serve index.html for all non-API, non-static routes
    prodApp.use("*", serveStatic({ root: "./dist/client", path: "index.html" }));

    const prodListener = getRequestListener(prodApp.fetch);
    server = createHttpServer((req, res) => {
      const url = req.url ?? "";
      const path = url.split("?", 1)[0] ?? "";
      if (path === "/api/mcp") {
        void handleMcpHttp(req, res).catch((e) => {
          console.error("[mcp] handler error:", e);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Internal MCP error" }));
          }
        });
        return;
      }
      prodListener(req, res);
    });
    server.listen(port);
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const url = parse(request.url ?? "", true);

    if (url.pathname === "/api/bastions/agent") {
      const bastion = await authenticateBastionAgent(request);
      if (!bastion) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      handleBastionAgentUpgrade(request, socket, head, bastion);
      return;
    }

    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }

    const token = url.query["token"] as string | undefined;
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Try short-lived session token first (from web app)
    let auth = validateWsToken(token);
    if (!auth) {
      // Fall back to API key auth (from desktop sync client)
      const fakeRequest = new Request("http://localhost", {
        headers: { authorization: `Bearer ${token}` },
      });
      auth = await authenticateApiRequest(fakeRequest);
    }
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, auth);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _request: unknown, auth: { organizationId: string; userId: string }) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            channel?: string;
            accountId?: string;
            resourceId?: string;
            data?: string;
            cols?: number;
            rows?: number;
            sql?: string;
            sshKeyId?: string;
            sshHost?: string;
            sshUsername?: string;
            agentForward?: boolean;
            peerPluginId?: string;
            namespace?: string;
            podName?: string;
            containerName?: string;
            resourceType?: string;
            resourceName?: string;
            remotePort?: number;
          };

          switch (msg.type) {
            case "ssh:open":
              if (msg.accountId) {
                void handleSshSession(
                  ws,
                  auth.organizationId,
                  msg.accountId,
                  msg.resourceId,
                  msg.sshKeyId
                    ? { sshKeyId: msg.sshKeyId, host: msg.sshHost!, username: msg.sshUsername! }
                    : undefined,
                  msg.cols,
                  msg.rows,
                  msg.agentForward === true,
                  auth.userId,
                );
              }
              break;
            case "ssh:data":
              break;
            case "ssh:resize":
              break;
            case "sql:query":
              if (msg.accountId && msg.sql) {
                void handleSqlSession(ws, auth.organizationId, msg.accountId, msg.sql);
              }
              break;
            case "k8s:exec:open":
              if (msg.accountId && msg.resourceId && msg.peerPluginId && msg.podName) {
                void (async () => {
                  try {
                    const kubeconfig = await resolveKubeconfig(
                      auth.organizationId,
                      msg.accountId!,
                      msg.resourceId!,
                      msg.peerPluginId!,
                    );
                    if (!kubeconfig) {
                      ws.send(
                        JSON.stringify({
                          type: "k8s:exec:error",
                          error: "Could not resolve kubeconfig",
                        }),
                      );
                      return;
                    }
                    await handleK8sExecSession(ws, {
                      kubeconfig,
                      namespace: msg.namespace ?? "default",
                      podName: msg.podName!,
                      containerName: msg.containerName,
                      cols: msg.cols ?? 80,
                      rows: msg.rows ?? 24,
                    });
                  } catch (e) {
                    ws.send(
                      JSON.stringify({
                        type: "k8s:exec:error",
                        error: e instanceof Error ? e.message : "K8s exec failed",
                      }),
                    );
                  }
                })();
              }
              break;
            case "k8s:exec:data":
              break;
            case "k9s:open":
              if (msg.accountId && msg.resourceId && msg.peerPluginId) {
                void (async () => {
                  try {
                    const kubeconfig = await resolveKubeconfig(
                      auth.organizationId,
                      msg.accountId!,
                      msg.resourceId!,
                      msg.peerPluginId!,
                    );
                    if (!kubeconfig) {
                      ws.send(
                        JSON.stringify({
                          type: "k9s:error",
                          error: "Could not resolve kubeconfig",
                        }),
                      );
                      return;
                    }
                    await handleK9sSession(ws, {
                      kubeconfig,
                      ...(msg.namespace ? { namespace: msg.namespace } : {}),
                      cols: msg.cols ?? 80,
                      rows: msg.rows ?? 24,
                    });
                  } catch (e) {
                    ws.send(
                      JSON.stringify({
                        type: "k9s:error",
                        error: e instanceof Error ? e.message : "k9s launch failed",
                      }),
                    );
                  }
                })();
              }
              break;
            case "k9s:data":
            case "k9s:resize":
              break;
            case "k8s:pf:open":
              if (
                msg.accountId &&
                msg.resourceId &&
                msg.peerPluginId &&
                msg.resourceType &&
                msg.resourceName &&
                msg.remotePort
              ) {
                void (async () => {
                  try {
                    const kubeconfig = await resolveKubeconfig(
                      auth.organizationId,
                      msg.accountId!,
                      msg.resourceId!,
                      msg.peerPluginId!,
                    );
                    if (!kubeconfig) {
                      ws.send(
                        JSON.stringify({
                          type: "k8s:pf:error",
                          error: "Could not resolve kubeconfig",
                        }),
                      );
                      return;
                    }
                    handleK8sPfSession(ws, {
                      kubeconfig,
                      namespace: msg.namespace ?? "default",
                      resourceType: msg.resourceType!,
                      resourceName: msg.resourceName!,
                      remotePort: msg.remotePort!,
                    });
                  } catch (e) {
                    ws.send(
                      JSON.stringify({
                        type: "k8s:pf:error",
                        error: e instanceof Error ? e.message : "port-forward failed",
                      }),
                    );
                  }
                })();
              }
              break;
            case "k8s:pf:data":
            case "k8s:pf:close":
              break;
          }
        } catch (e) {
          console.error("[ws] Invalid message:", e);
        }
      });
    },
  );

  console.log(`> Ready on http://localhost:${port}`);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
