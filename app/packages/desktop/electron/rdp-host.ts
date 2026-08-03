// IPC surface for the embedded RDP client. Two jobs:
//
//   1. Back the renderer's WebSocket shim (src/lib/rdp-transport.ts): each RDP
//      session is a byte channel tunnelled over IPC, and this side runs the
//      RDCleanPath handshake + TCP/TLS relay to the real server (@infrawrench/rdp-core).
//      No listening socket is opened — the renderer can't do raw TCP, so only
//      the relay endpoints live here.
//
//   2. Bridge the CLIPRDR file-transfer channel to the local filesystem —
//      reading a chosen upload file in chunks, and writing a downloaded file
//      to a save-dialog path. Both are gated on dialog-blessed paths, exactly
//      like sftp_upload / sftp_download, so a compromised renderer can't read
//      or write arbitrary files.
import { app, ipcMain, dialog, BrowserWindow, type WebContents } from "electron";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { handleRdpChannel, type RdpChannel } from "@infrawrench/rdp-core";
import { isDialogBlessedPath, registerDialogBlessedPath } from "./main-utils";

// ── Per-session IPC byte relay ─────────────────────────────────────────────

interface RdpSession {
  id: string;
  // WeakRef so a torn-down renderer doesn't pin the webContents (mirrors
  // ssh-shell.ts). Data is pushed on the dynamic `rdp_ws_data_<id>` channel.
  sender: WeakRef<WebContents>;
  onMessage: ((data: Buffer) => void) | null;
  onClose: (() => void) | null;
  // Frames that arrive before the proxy has installed a handler (there is at
  // most the single RDCleanPath request, but buffer defensively).
  queue: Buffer[];
  closed: boolean;
}

const sessions = new Map<string, RdpSession>();

function makeChannel(session: RdpSession): RdpChannel {
  return {
    onMessage(cb: (data: Buffer) => void) {
      session.onMessage = cb;
      while (session.queue.length > 0 && session.onMessage) {
        session.onMessage(session.queue.shift()!);
      }
    },
    send(data: Buffer) {
      const wc = session.sender.deref();
      if (wc && !wc.isDestroyed()) wc.send(`rdp_ws_data_${session.id}`, data);
    },
    onClose(cb: () => void) {
      session.onClose = cb;
    },
    close() {
      teardownSession(session.id, true);
    },
  };
}

function teardownSession(id: string, notifyRenderer: boolean): void {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  session.closed = true;
  try {
    session.onClose?.();
  } catch {
    /* relay teardown is best-effort */
  }
  if (notifyRenderer) {
    const wc = session.sender.deref();
    if (wc && !wc.isDestroyed()) wc.send(`rdp_ws_closed_${id}`);
  }
  sessions.delete(id);
}

/** Allocate a session and kick off the RDCleanPath handler. */
ipcMain.handle("rdp_session_open", (event) => {
  const id = crypto.randomUUID();
  const session: RdpSession = {
    id,
    sender: new WeakRef(event.sender),
    onMessage: null,
    onClose: null,
    queue: [],
    closed: false,
  };
  sessions.set(id, session);
  handleRdpChannel(makeChannel(session));
  return { sessionId: id };
});

const SessionIdArgs = z.object({ sessionId: z.string().min(1).max(64) });

/** A frame from the shimmed WebSocket. Kept validation light — this is hot. */
ipcMain.handle("rdp_ws_send", (_e, raw: unknown) => {
  const { sessionId, data } = raw as { sessionId: string; data: Uint8Array };
  const session = sessions.get(sessionId);
  if (!session || session.closed || !(data instanceof Uint8Array)) return;
  // Copy out of the transferred view before it can be reused/neutered.
  const buf = Buffer.from(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (session.onMessage) session.onMessage(buf);
  else session.queue.push(buf);
});

/** The shimmed WebSocket closed on the renderer side. */
ipcMain.handle("rdp_ws_close", (_e, raw: unknown) => {
  const { sessionId } = SessionIdArgs.parse(raw);
  teardownSession(sessionId, false);
});

export function closeRdpProxy(): void {
  for (const id of [...sessions.keys()]) teardownSession(id, false);
}

// ── File-transfer bridge (CLIPRDR) ─────────────────────────────────────────

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const StatArgs = z.object({ path: z.string().min(1).max(4096) });
const ReadArgs = z.object({
  path: z.string().min(1).max(4096),
  position: z.number().int().min(0),
  length: z.number().int().min(0).max(MAX_CHUNK_BYTES),
});
const SaveArgs = z.object({
  name: z.string().min(1).max(512),
  // The full file, base64-encoded. RDP clipboard transfers are whole-file, and
  // the renderer accumulates chunks before writing, matching the CLIPRDR flow.
  base64: z.string().max(Math.ceil((512 * 1024 * 1024) / 3) * 4),
});

/** stat a dialog-chosen upload file so the client can advertise its size. */
ipcMain.handle("rdp_local_file_stat", async (_e, raw: unknown) => {
  const { path: filePath } = StatArgs.parse(raw);
  if (!isDialogBlessedPath(filePath)) {
    throw new Error("rdp_local_file_stat: path was not chosen via a file dialog");
  }
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("rdp_local_file_stat: not a regular file");
  return { size: stat.size, name: path.basename(filePath), modifiedMs: stat.mtimeMs };
});

/** Read a slice of a dialog-chosen upload file for the CLIPRDR data stream. */
ipcMain.handle("rdp_local_file_read", async (_e, raw: unknown) => {
  const { path: filePath, position, length } = ReadArgs.parse(raw);
  if (!isDialogBlessedPath(filePath)) {
    throw new Error("rdp_local_file_read: path was not chosen via a file dialog");
  }
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return { base64: buffer.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
});

/** Prompt for a save location and write a downloaded remote file to it. */
ipcMain.handle("rdp_save_download", async (_e, raw: unknown) => {
  const { name, base64 } = SaveArgs.parse(raw);
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showSaveDialog(win, { defaultPath: name })
    : await dialog.showSaveDialog({ defaultPath: name });
  if (result.canceled || !result.filePath) return { saved: false as const };
  registerDialogBlessedPath(result.filePath);
  await fsp.writeFile(result.filePath, Buffer.from(base64, "base64"));
  return { saved: true as const, path: result.filePath };
});

// Belt-and-suspenders: drop the proxy when the app is on its way out. main.ts's
// before-quit also calls closeRdpProxy(); this covers a hard quit path.
app.on("will-quit", () => {
  closeRdpProxy();
});
