/**
 * Hono API server + Vite SPA dev middleware + WebSocket support
 * for SSH terminals, SQL query proxy, and K8s exec sessions.
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { parse } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { api } from "./src/api/index";
import { applySecurityHeaders, securityHeaders } from "./src/api/security-headers";
import { handleSshSession } from "./src/services/ssh-proxy";
import { handleConsoleAttach } from "./src/services/shared-console/attach";
import { handleSqlSession } from "./src/services/sql-proxy";
import { handleK8sExecSession } from "./src/services/k8s-exec-proxy";
import { handleK9sSession } from "./src/services/k9s-proxy";
import { handleK8sPfSession } from "./src/services/k8s-pf-proxy";
import { handleWorkflowSession } from "./src/services/workflow-ws";
import { handleDeploymentSession } from "./src/services/deployment-ws";
import { resolveKubeconfig } from "./src/services/k8s-kubeconfig-resolver";
import { authenticateApiRequest, requireScope } from "./src/auth/api-auth";
import { validateWsToken } from "./src/services/ws-tokens";
import { handleAppsSession } from "./src/services/apps-proxy";
import { handleMcpHttp } from "./src/mcp/http-handler";
import { migrateMetrics } from "@infrawrench/server-core/clickhouse/migrate";
import { authenticateBastionAgent, handleBastionAgentUpgrade } from "./src/services/bastion-ws";

const dev = process.env["NODE_ENV"] !== "production";
const port = parseInt(process.env["PORT"] ?? "3000", 10);

/**
 * Unauthenticated liveness/readiness endpoint for load balancers and k8s probes.
 *
 * Like `/api/mcp`, this is answered ahead of the Hono listener and so has to
 * set the security headers itself — both server modes route through here, so
 * doing it in the one function covers both.
 */
function respondHealthz(res: import("node:http").ServerResponse): void {
  applySecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("ok");
}

/**
 * Keep one broken request from taking everybody's sessions with it.
 *
 * This process holds long-lived state for many people at once — SSH shells,
 * SQL connections, application streams — and Node's default for an unhandled
 * rejection or an uncaught exception is to end the process. On a request
 * handler that would be defensible; here it means every other customer's
 * terminal dies because one socket reset at the wrong moment, and it shows up
 * as a gateway error to all of them.
 *
 * So both are logged loudly and survived. The risk of carrying on after an
 * exception is real — the state it came from may be inconsistent — but it is
 * bounded to whatever was mid-flight, and the alternative is not bounded to
 * anything. Anything that reaches here is a bug with a stack trace attached:
 * fix it there rather than relying on this.
 */
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[server] uncaught exception:", error);
  });
}

async function start() {
  installProcessGuards();
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
      if (path === "/healthz") {
        respondHealthz(res);
      } else if (path === "/api/mcp") {
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

    // The SPA shell and every static asset are served by this app, not by
    // `api`, so they need the headers mounted here too — the framing defence
    // matters most on exactly the HTML document `api` never emits.
    prodApp.use("*", securityHeaders());

    prodApp.route("/", api);
    prodApp.use("*", serveStatic({ root: "./dist/client" }));
    // A hashed asset that isn't on disk must 404, never fall back to index.html:
    // during a rolling deploy an old pod can get a request for a new bundle, and
    // a 200 text/html response under a .css/.js URL is cached by extension at the
    // CDN for hours, breaking the app for everyone. no-store keeps the miss out
    // of the cache so the browser recovers on the next load.
    prodApp.use("/assets/*", async (c) => {
      c.header("cache-control", "no-store");
      return c.text("Not found", 404);
    });
    // SPA fallback: serve index.html for all non-API, non-static routes
    prodApp.use("*", serveStatic({ root: "./dist/client", path: "index.html" }));

    const prodListener = getRequestListener(prodApp.fetch);
    server = createHttpServer((req, res) => {
      const url = req.url ?? "";
      const path = url.split("?", 1)[0] ?? "";
      if (path === "/healthz") {
        respondHealthz(res);
        return;
      }
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

  // permessage-deflate: terminal sessions ship base64-in-JSON frames of TUI
  // redraws, which compress extremely well; browsers and Electron negotiate
  // the extension automatically and plain clients fall back to uncompressed.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  // Application frames are already compressed — zstd inside, or an image codec
  // — so deflating them again would burn a core per session for nothing.
  const appsWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  /**
   * Same auth the /api/ws upgrade uses: a short-lived ws-token minted by the
   * app (already gated on `resources:execute`), or an API key carrying that
   * scope. Starting an application on a host is the same authority as opening
   * a shell on it, so it is gated the same way.
   */
  async function resolveAppsAuth(
    token: string,
  ): Promise<{ organizationId: string; userId?: string } | null> {
    const sessionAuth = await validateWsToken(token);
    if (sessionAuth) return sessionAuth;
    const fakeRequest = new Request("http://localhost", {
      headers: { authorization: `Bearer ${token}` },
    });
    const keyAuth = await authenticateApiRequest(fakeRequest);
    if (!keyAuth) return null;
    try {
      requireScope(keyAuth, "resources:execute");
      return keyAuth;
    } catch {
      return null;
    }
  }

  // Wrapped, because the body is `async`: a rejection out of an event listener
  // is an unhandled rejection, and Node ends the process on one of those. Every
  // await in here can fail for reasons that are nobody's fault — a database
  // blip while resolving a token — and one of those must cost the caller their
  // socket, not everybody else theirs.
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch((error) => {
      console.error("[ws] upgrade failed:", error);
      try {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      } catch {
        /* the socket is already gone, which is why we are here */
      }
    });
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
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

    if (url.pathname === "/api/apps") {
      const token = url.query["token"] as string | undefined;
      const auth = token ? await resolveAppsAuth(token) : null;
      if (!auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const accountId = url.query["account"] as string | undefined;
      const resourceId = url.query["resource"] as string | undefined;
      const sshKeyId = url.query["key"] as string | undefined;
      const host = url.query["host"] as string | undefined;
      const username = url.query["user"] as string | undefined;
      if (!accountId || !resourceId || !sshKeyId || !host || !username) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      appsWss.handleUpgrade(request, socket, head, (ws) => {
        void handleAppsSession(ws, {
          organizationId: auth.organizationId,
          ...(auth.userId ? { userId: auth.userId } : {}),
          accountId,
          resourceId,
          sshKeyId,
          host,
          username,
        });
      });
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

    // Try short-lived session token first (from web app). Those are minted by
    // POST /ws-token, which already gates on `resources:execute`.
    let auth = await validateWsToken(token);
    if (!auth) {
      // Fall back to API key auth (from desktop sync client). Unlike the
      // ws-token path there is no prior permission check, so enforce the same
      // `resources:execute` scope here — every channel this socket can open
      // (SSH, SQL, k8s exec, port-forward, workflow runs) reaches customer
      // infrastructure, and a read-scoped key must not get there.
      const fakeRequest = new Request("http://localhost", {
        headers: { authorization: `Bearer ${token}` },
      });
      const keyAuth = await authenticateApiRequest(fakeRequest);
      if (keyAuth) {
        try {
          requireScope(keyAuth, "resources:execute");
          auth = keyAuth;
        } catch {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      }
    }
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, auth);
    });
  }

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
            connectThroughAccountId?: string;
            peerPluginId?: string;
            namespace?: string;
            podName?: string;
            containerName?: string;
            resourceType?: string;
            resourceName?: string;
            remotePort?: number;
            workflowId?: string;
            /** Load-balancer affinity hint; see services/shared-console/hub.ts. */
            routingKey?: string;
            sharedConsoleId?: string;
            repo?: string;
            branch?: string;
            env?: string;
            planOnly?: boolean;
            answers?: Record<string, string>;
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
                    ? {
                        sshKeyId: msg.sshKeyId,
                        host: msg.sshHost!,
                        username: msg.sshUsername!,
                        ...(msg.connectThroughAccountId
                          ? { connectThroughAccountId: msg.connectThroughAccountId }
                          : {}),
                      }
                    : undefined,
                  msg.cols,
                  msg.rows,
                  msg.agentForward === true,
                  auth.userId,
                  msg.routingKey,
                );
              }
              break;
            case "ssh:data":
              break;
            case "ssh:resize":
              break;
            // A guest attaching to somebody else's live session. Everything
            // after the handshake is handled by the listener the attach
            // registers, exactly like the workflow debugger's frames.
            case "console:attach":
              if (msg.sharedConsoleId) {
                void handleConsoleAttach(ws, auth, msg.sharedConsoleId).catch((e) => {
                  console.error("[shared-console] attach failed:", e);
                  ws.send(
                    JSON.stringify({
                      type: "console:error",
                      code: "attach_failed",
                      error: "Could not join that session.",
                    }),
                  );
                });
              }
              break;
            case "console:input":
            case "console:viewport":
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
            case "workflow:run":
              if (msg.workflowId) {
                handleWorkflowSession(ws, auth.organizationId, msg.workflowId, auth.userId);
              }
              break;
            // Subsequent debugger messages are handled by the session's own
            // listener registered in handleWorkflowSession.
            case "workflow:continue":
            case "workflow:step":
            case "workflow:stop":
            case "workflow:prompt:response":
              break;
            case "deploy:run":
              if (msg.repo && msg.branch) {
                handleDeploymentSession(ws, auth.organizationId, {
                  repo: msg.repo,
                  branch: msg.branch,
                  userId: auth.userId,
                  ...(msg.env ? { env: msg.env } : {}),
                  ...(msg.planOnly ? { planOnly: true } : {}),
                  ...(msg.answers ? { answers: msg.answers } : {}),
                });
              }
              break;
            // Subsequent deploy messages are handled by the session's own
            // listener registered in handleDeploymentSession.
            case "deploy:stop":
            case "deploy:prompt:response":
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
