// Server-side RDP proxy for the web app. The browser's ironrdp-wasm client
// can't open TCP, so it speaks RDP-over-RDCleanPath to this endpoint over a real
// WebSocket; we resolve the destination from the authenticated resource, refuse
// internal address space (SSRF), and run the shared RDCleanPath handshake +
// TLS relay (@infrawrench/rdp-core).
import type { WebSocket, RawData } from "ws";
import { handleRdpChannel, type RdpChannel } from "@infrawrench/rdp-core";
import { assertHostNotInternal } from "@/services/host-validation";
import { resolveRdpTarget } from "@/services/rdp";

/** Adapt a server-side `ws` socket to the transport-agnostic RdpChannel. */
function wsChannel(ws: WebSocket): RdpChannel {
  let messageHandler: ((data: Buffer) => void) | null = null;
  const queue: Buffer[] = [];

  ws.on("message", (data: RawData) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    if (messageHandler) messageHandler(buf);
    else queue.push(buf);
  });

  return {
    onMessage(cb) {
      messageHandler = cb;
      while (queue.length > 0 && messageHandler) messageHandler(queue.shift()!);
    },
    send(data: Buffer) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          /* peer went away mid-frame */
        }
      }
    },
    onClose(cb) {
      ws.on("close", cb);
      ws.on("error", cb);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

export async function handleRdpSession(
  ws: WebSocket,
  organizationId: string,
  accountId: string,
  resourceId: string,
): Promise<void> {
  try {
    const target = await resolveRdpTarget(organizationId, accountId, resourceId);
    if (!target) {
      ws.close(1008, "resource is not an RDP-capable running Windows VM");
      return;
    }
    // The resolved host comes from the resource's own outputs, but it's still a
    // user-controlled value (a public IP the provider reported) — refuse
    // loopback / link-local / metadata address space exactly as the SSH proxy
    // does before dialling it.
    await assertHostNotInternal(target.host);

    handleRdpChannel(wsChannel(ws), { destinationOverride: `${target.host}:${target.port}` });
  } catch (err) {
    console.warn("[rdp] session setup failed:", err instanceof Error ? err.message : err);
    try {
      ws.close(1011, "rdp session failed");
    } catch {
      /* already gone */
    }
  }
}
