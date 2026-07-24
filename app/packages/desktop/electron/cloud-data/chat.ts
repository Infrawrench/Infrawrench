import { ipcMain } from "electron";
import { cloudFetch } from "./shared";
import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";

// Org-level AI chat — cloud-mode only. CRUD proxies through cloudFetch; the
// turn stream is a Bearer-authenticated SSE fetch parsed here in main, with
// each event forwarded to the renderer on `cloud_chat_stream_<streamId>`.

ipcMain.handle("cloud_chat_list_conversations", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/chat/conversations");
});

ipcMain.handle(
  "cloud_chat_create_conversation",
  async (_e, { orgId, model }: { orgId: string; model?: string }) => {
    return cloudFetch(orgId, "/chat/conversations", {
      method: "POST",
      body: JSON.stringify(model ? { model } : {}),
    });
  },
);

ipcMain.handle(
  "cloud_chat_get_conversation",
  async (_e, { orgId, conversationId }: { orgId: string; conversationId: string }) => {
    return cloudFetch(orgId, `/chat/conversations/${encodeURIComponent(conversationId)}`);
  },
);

ipcMain.handle(
  "cloud_chat_archive_conversation",
  async (_e, { orgId, conversationId }: { orgId: string; conversationId: string }) => {
    return cloudFetch(orgId, `/chat/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle("cloud_chat_spend", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/chat/spend");
});

ipcMain.handle(
  "cloud_chat_resolve_pending",
  async (
    _e,
    {
      orgId,
      conversationId,
      pendingId,
      action,
      reason,
    }: {
      orgId: string;
      conversationId: string;
      pendingId: string;
      action: "approve" | "reject";
      reason?: string;
    },
  ) => {
    return cloudFetch(
      orgId,
      `/chat/conversations/${encodeURIComponent(conversationId)}/pending/${encodeURIComponent(pendingId)}`,
      { method: "POST", body: JSON.stringify({ action, ...(reason ? { reason } : {}) }) },
    );
  },
);

const activeStreams = new Map<string, AbortController>();

ipcMain.handle(
  "cloud_chat_stream_start",
  async (
    e,
    {
      orgId,
      conversationId,
      streamId,
      body,
    }: {
      orgId: string;
      conversationId: string;
      streamId: string;
      body: { text?: string; resume?: boolean };
    },
  ) => {
    const channel = `cloud_chat_stream_${streamId}`;
    const controller = new AbortController();
    activeStreams.set(streamId, controller);

    const send = (ev: Record<string, unknown>): void => {
      if (!e.sender.isDestroyed()) e.sender.send(channel, ev);
    };

    try {
      let token = await getAccessToken();
      if (!token) throw new Error("Not authenticated to Infrawrench Cloud");

      const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
      const doFetch = (t: string) =>
        fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

      let res = await doFetch(token);
      if (res.status === 401) {
        const refreshed = await forceRefreshAccessToken();
        if (!refreshed) throw new Error("Authentication expired; please sign in again");
        token = refreshed;
        res = await doFetch(token);
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Cloud request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line: event:<name>\ndata:<json>
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let dataLine = "";
          for (const ln of frame.split("\n")) {
            if (ln.startsWith("data:")) dataLine += ln.slice(5).trimStart();
          }
          if (!dataLine) continue;
          try {
            send(JSON.parse(dataLine) as Record<string, unknown>);
          } catch {
            continue;
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        send({ type: "error", message: err instanceof Error ? err.message : "Chat stream failed" });
      }
    } finally {
      activeStreams.delete(streamId);
    }
  },
);

ipcMain.handle("cloud_chat_stream_abort", (_e, { streamId }: { streamId: string }) => {
  activeStreams.get(streamId)?.abort();
  activeStreams.delete(streamId);
});
