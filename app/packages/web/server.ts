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
import { authenticateApiRequest } from "./src/auth/api-auth";
import { validateWsToken } from "./src/services/ws-tokens";

const dev = process.env["NODE_ENV"] !== "production";
const port = parseInt(process.env["PORT"] ?? "3000", 10);

async function start() {
  const honoListener = getRequestListener(api.fetch);
  let server: ReturnType<typeof createHttpServer>;

  if (dev) {
    // In dev: Vite dev server in middleware mode, Hono for API routes
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    // Route at the Node.js HTTP level: API/callback → Hono, everything else → Vite
    server = createHttpServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/api/") || url.startsWith("/callback")) {
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
    server = createHttpServer(prodListener);
    server.listen(port);
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const url = parse(request.url ?? "", true);

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

  wss.on("connection", (ws: WebSocket, _request: unknown, auth: { organizationId: string; userId: string }) => {
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
        };

        switch (msg.type) {
          case "ssh:open":
            if (msg.accountId) {
              void handleSshSession(ws, auth.organizationId, msg.accountId, msg.resourceId, msg.sshKeyId ? { sshKeyId: msg.sshKeyId, host: msg.sshHost!, username: msg.sshUsername! } : undefined, msg.cols, msg.rows);
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
        }
      } catch (e) {
        console.error("[ws] Invalid message:", e);
      }
    });
  });

  console.log(`> Ready on http://localhost:${port}`);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
