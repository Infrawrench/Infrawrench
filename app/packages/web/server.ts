/**
 * Custom Next.js server with WebSocket support for SSH terminals,
 * SQL query proxy, and K8s exec sessions.
 */
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { handleSshSession } from "./src/services/ssh-proxy";
import { handleSqlSession } from "./src/services/sql-proxy";
import { authenticateApiRequest } from "./src/auth/api-auth";

const dev = process.env["NODE_ENV"] !== "production";
const hostname = "localhost";
const port = parseInt(process.env["PORT"] ?? "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "", true);
    void handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const url = parse(request.url ?? "", true);

    // Only handle /api/ws
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }

    // Authenticate via query param token or cookie
    const token = url.query["token"] as string | undefined;
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const fakeRequest = new Request("http://localhost", {
      headers: { authorization: `Bearer ${token}` },
    });
    const auth = await authenticateApiRequest(fakeRequest);
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
        };

        switch (msg.type) {
          case "ssh:open":
            if (msg.accountId) {
              void handleSshSession(ws, auth.organizationId, msg.accountId, msg.resourceId);
            }
            break;
          case "ssh:data":
            // stdin data is forwarded by the ssh session handler
            break;
          case "ssh:resize":
            // resize is forwarded by the ssh session handler
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

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
