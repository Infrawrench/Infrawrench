import { useCallback, useEffect, useRef, useState } from "react";
import {
  RdpFileTransferManager,
  scancodeFor,
  type RdpUploadFile,
  type RdpFileSink,
} from "@infrawrench/client-core";
import { invoke } from "../lib/invoke";
import { installRdpWebSocketShim, rdpProxyAddress } from "../lib/rdp-transport";

// Desktop file I/O for RDP transfer: reads run through the dialog-blessed-path
// IPC in electron/rdp-host.ts; downloads go through a native save dialog.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
const desktopRdpFileSink: RdpFileSink = {
  save: (name, bytes) =>
    invoke<{ saved: boolean; path?: string }>("rdp_save_download", {
      name,
      base64: bytesToBase64(bytes),
    }),
};

// Minimal typing over the ironrdp-wasm surface we use (see its rdp_client.d.ts).
interface IronRdpModule {
  default: (init?: unknown) => Promise<unknown>;
  setup: (level: string) => void;
  SessionBuilder: new () => IronRdpSessionBuilder;
  DesktopSize: new (width: number, height: number) => unknown;
  InputTransaction: new () => { addEvent(event: unknown): void };
  DeviceEvent: {
    keyPressed(scancode: number): unknown;
    keyReleased(scancode: number): unknown;
    mouseButtonPressed(button: number): unknown;
    mouseButtonReleased(button: number): unknown;
    mouseMove(x: number, y: number): unknown;
    wheelRotations(vertical: boolean, amount: number, unit: number): unknown;
  };
  Extension: new (ident: string, value: unknown) => unknown;
  ClipboardData: new () => { addText(mime: string, text: string): void };
}

interface IronRdpSessionBuilder {
  username(v: string): IronRdpSessionBuilder;
  password(v: string): IronRdpSessionBuilder;
  destination(v: string): IronRdpSessionBuilder;
  proxyAddress(v: string): IronRdpSessionBuilder;
  authToken(v: string): IronRdpSessionBuilder;
  serverDomain(v: string): IronRdpSessionBuilder;
  desktopSize(v: unknown): IronRdpSessionBuilder;
  renderCanvas(v: HTMLCanvasElement): IronRdpSessionBuilder;
  extension(v: unknown): IronRdpSessionBuilder;
  remoteClipboardChangedCallback(cb: (data: RemoteClipboard) => void): IronRdpSessionBuilder;
  forceClipboardUpdateCallback(cb: () => void): IronRdpSessionBuilder;
  setCursorStyleCallback(cb: (style: string) => void): IronRdpSessionBuilder;
  setCursorStyleCallbackContext(ctx: unknown): IronRdpSessionBuilder;
  connect(): Promise<IronRdpSession>;
}

interface RemoteClipboard {
  isEmpty(): boolean;
  items(): { mimeType(): string; value(): unknown }[];
}

interface IronRdpSession {
  run(): Promise<{ reason(): string }>;
  desktopSize(): { width: number; height: number };
  applyInputs(tx: unknown): void;
  onClipboardPaste(data: unknown): Promise<void>;
  shutdown(): void;
  invokeExtension(ext: unknown): unknown;
}

const RESOLUTIONS = [
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "1440 × 900", width: 1440, height: 900 },
  { label: "1600 × 900", width: 1600, height: 900 },
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "2560 × 1440", width: 2560, height: 1440 },
];

let ironRdpModule: IronRdpModule | null = null;

async function loadIronRdp(): Promise<IronRdpModule> {
  if (ironRdpModule) return ironRdpModule;
  const mod = (await import("ironrdp-wasm")) as unknown as IronRdpModule;
  await mod.default();
  mod.setup("info");
  ironRdpModule = mod;
  return mod;
}

export interface RdpViewerProps {
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
}

type Status = "connecting" | "connected" | "error";

export function RdpViewer({ host, port, username, password, domain }: RdpViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<IronRdpSession | null>(null);
  const fileTransferRef = useRef<RdpFileTransferManager | null>(null);
  const inputHandlersBound = useRef(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolution, setResolution] = useState(RESOLUTIONS[3]!);
  const [hasRemoteFiles, setHasRemoteFiles] = useState(false);
  const [uploadArmed, setUploadArmed] = useState(false);
  const [reconnectCounter, setReconnectCounter] = useState(0);

  const cleanup = useCallback(() => {
    if (sessionRef.current) {
      try {
        sessionRef.current.shutdown();
      } catch {
        /* already gone */
      }
      sessionRef.current = null;
    }
    fileTransferRef.current?.cleanup();
    fileTransferRef.current = null;
  }, []);

  const syncLocalClipboardToRemote = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !ironRdpModule) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const data = new ironRdpModule.ClipboardData();
      data.addText("text/plain", text);
      await session.onClipboardPaste(data);
    } catch {
      /* clipboard permission denied or empty — non-fatal */
    }
  }, []);

  // Connect / reconnect.
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setStatus("connecting");
    setErrorMessage(null);
    setHasRemoteFiles(false);

    async function connect() {
      try {
        installRdpWebSocketShim();
        const rdp = await loadIronRdp();
        if (cancelled) return;

        const { sessionId } = await invoke<{ sessionId: string }>("rdp_session_open");
        if (cancelled) return;

        const { width, height } = resolution;
        const builder = new rdp.SessionBuilder();
        builder.username(username);
        builder.password(password);
        builder.destination(`${host}:${port}`);
        builder.proxyAddress(rdpProxyAddress(sessionId));
        builder.authToken("none");
        if (domain) builder.serverDomain(domain);
        builder.desktopSize(new rdp.DesktopSize(width, height));
        builder.renderCanvas(canvas!);
        builder.extension(new rdp.Extension("enable_credssp", true));

        const fileTransfer = new RdpFileTransferManager(
          () => sessionRef.current,
          rdp.Extension,
          (msg, level) => console.debug(`[rdp-file][${level ?? "info"}] ${msg}`),
          {
            onRemoteFilesChanged: (has) => !cancelled && setHasRemoteFiles(has),
            onUploadInProgress: (inProgress) => !cancelled && setUploadArmed(inProgress),
            onDownloadComplete: () => {
              /* notification handled by the toolbar affordance */
            },
          },
          desktopRdpFileSink,
        );
        fileTransferRef.current = fileTransfer;
        for (const ext of fileTransfer.createExtensions()) builder.extension(ext);

        builder.remoteClipboardChangedCallback((clipboard) => {
          try {
            if (clipboard.isEmpty()) return;
            for (const item of clipboard.items()) {
              if (item.mimeType() === "text/plain") {
                void navigator.clipboard.writeText(String(item.value()));
              }
            }
          } catch {
            /* clipboard sync best-effort */
          }
        });
        builder.forceClipboardUpdateCallback(() => void syncLocalClipboardToRemote());
        builder.setCursorStyleCallbackContext(canvas);
        builder.setCursorStyleCallback((style: string) => {
          canvas!.style.cursor = style || "default";
        });

        const session = await builder.connect();
        if (cancelled) {
          session.shutdown();
          return;
        }
        sessionRef.current = session;

        const size = session.desktopSize();
        canvas!.width = size.width;
        canvas!.height = size.height;
        setStatus("connected");
        canvas!.focus();

        session
          .run()
          .then(() => !cancelled && setStatus("error"))
          .catch((e: unknown) => {
            if (!cancelled) {
              setStatus("error");
              setErrorMessage(formatIronRdpError(e));
            }
          });
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(formatIronRdpError(e));
        }
      }
    }

    void connect();
    return () => {
      cancelled = true;
      cleanup();
    };
    // reconnectCounter forces a fresh connect; resolution change reconnects too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, username, password, domain, resolution, reconnectCounter]);

  // Input handlers — bound once to the canvas element.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || inputHandlersBound.current) return;
    inputHandlersBound.current = true;

    const applyKey = (code: string, pressed: boolean) => {
      const session = sessionRef.current;
      if (!session || !ironRdpModule) return;
      const scancode = scancodeFor(code);
      if (scancode === null) return;
      const event = pressed
        ? ironRdpModule.DeviceEvent.keyPressed(scancode)
        : ironRdpModule.DeviceEvent.keyReleased(scancode);
      const tx = new ironRdpModule.InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      applyKey(e.code, true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      applyKey(e.code, false);
    };
    const onMouseMove = (e: MouseEvent) => {
      const session = sessionRef.current;
      if (!session || !ironRdpModule) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) * canvas.width) / rect.width);
      const y = Math.round(((e.clientY - rect.top) * canvas.height) / rect.height);
      const tx = new ironRdpModule.InputTransaction();
      tx.addEvent(ironRdpModule.DeviceEvent.mouseMove(x, y));
      session.applyInputs(tx);
    };
    const onMouseButton = (e: MouseEvent, pressed: boolean) => {
      e.preventDefault();
      if (pressed) canvas.focus();
      const session = sessionRef.current;
      if (!session || !ironRdpModule) return;
      const event = pressed
        ? ironRdpModule.DeviceEvent.mouseButtonPressed(e.button)
        : ironRdpModule.DeviceEvent.mouseButtonReleased(e.button);
      const tx = new ironRdpModule.InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const session = sessionRef.current;
      if (!session || !ironRdpModule) return;
      const tx = new ironRdpModule.InputTransaction();
      if (e.deltaY !== 0) {
        tx.addEvent(ironRdpModule.DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, 1));
      }
      if (e.deltaX !== 0) {
        tx.addEvent(ironRdpModule.DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, 1));
      }
      session.applyInputs(tx);
    };
    const onMouseDown = (e: MouseEvent) => onMouseButton(e, true);
    const onMouseUp = (e: MouseEvent) => onMouseButton(e, false);
    const onContextMenu = (e: Event) => e.preventDefault();
    const onFocus = () => void syncLocalClipboardToRemote();

    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("focus", onFocus);

    return () => {
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("focus", onFocus);
      inputHandlersBound.current = false;
    };
  }, [syncLocalClipboardToRemote]);

  useEffect(() => () => cleanup(), [cleanup]);

  function sendCtrlAltDel() {
    const session = sessionRef.current;
    if (!session || !ironRdpModule) return;
    const D = ironRdpModule.DeviceEvent;
    const tx = new ironRdpModule.InputTransaction();
    tx.addEvent(D.keyPressed(0x1d)); // Ctrl
    tx.addEvent(D.keyPressed(0x38)); // Alt
    tx.addEvent(D.keyPressed(0xe053)); // Delete (extended)
    tx.addEvent(D.keyReleased(0xe053));
    tx.addEvent(D.keyReleased(0x38));
    tx.addEvent(D.keyReleased(0x1d));
    session.applyInputs(tx);
  }

  async function handleUpload() {
    const result = await invoke<{ canceled: boolean; filePaths: string[] }>("show_open_dialog", {
      title: "Choose files to upload to the remote desktop",
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const files: RdpUploadFile[] = [];
    for (const filePath of result.filePaths) {
      try {
        const stat = await invoke<{ size: number; name: string; modifiedMs: number }>(
          "rdp_local_file_stat",
          { path: filePath },
        );
        files.push({
          name: stat.name,
          size: stat.size,
          lastModified: stat.modifiedMs,
          read: (position, length) =>
            invoke<{ base64: string }>("rdp_local_file_read", {
              path: filePath,
              position,
              length,
            }).then((r) => base64ToBytes(r.base64)),
        });
      } catch (err) {
        console.warn(`[rdp] skipping ${filePath}:`, err);
      }
    }
    if (files.length === 0) return;
    setUploadArmed(true);
    fileTransferRef.current?.uploadFiles(files);
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-black">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface">
        <button
          type="button"
          onClick={() => setReconnectCounter((v) => v + 1)}
          className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border rounded"
        >
          Reconnect
        </button>
        <select
          value={resolution.label}
          onChange={(e) =>
            setResolution(RESOLUTIONS.find((r) => r.label === e.target.value) ?? RESOLUTIONS[3]!)
          }
          className="px-2 py-1 text-xs bg-surface border border-border rounded text-on-surface-secondary"
        >
          {RESOLUTIONS.map((r) => (
            <option key={r.label} value={r.label}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={sendCtrlAltDel}
          disabled={status !== "connected"}
          className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border rounded disabled:opacity-40"
        >
          Ctrl+Alt+Del
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void handleUpload()}
          disabled={status !== "connected"}
          title="Choose local files, then paste inside the remote session to upload them"
          className={`px-2 py-1 text-xs border border-border rounded disabled:opacity-40 ${
            uploadArmed
              ? "text-emerald-400 border-emerald-500/40"
              : "text-on-surface-muted hover:text-on-surface-secondary"
          }`}
        >
          Upload files
        </button>
        <button
          type="button"
          onClick={() => fileTransferRef.current?.downloadFiles()}
          disabled={status !== "connected" || !hasRemoteFiles}
          title="Copy files inside the remote session, then click to save them locally"
          className={`px-2 py-1 text-xs border border-border rounded disabled:opacity-40 ${
            hasRemoteFiles
              ? "text-emerald-400 border-emerald-500/40"
              : "text-on-surface-muted hover:text-on-surface-secondary"
          }`}
        >
          Download files
        </button>
        <span className="text-xs text-on-surface-faint ml-1">
          {username}@{host}:{port}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="outline-none"
          style={{ display: status === "connected" ? "block" : "none" }}
        />
        {status === "connecting" && (
          <div className="text-sm text-on-surface-muted animate-pulse">Connecting to {host}…</div>
        )}
        {status === "error" && (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <div className="text-sm text-red-400">Remote Desktop session ended</div>
            {errorMessage && <div className="text-xs text-on-surface-faint">{errorMessage}</div>}
            <button
              type="button"
              onClick={() => setReconnectCounter((v) => v + 1)}
              className="mt-1 px-3 py-1 text-xs border border-border rounded text-on-surface-secondary hover:border-border-strong"
            >
              Reconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const ERROR_KIND_NAMES: Record<number, string> = {
  0: "General error",
  1: "Wrong password",
  2: "Logon failure",
  3: "Access denied",
  4: "Connection error (RDCleanPath)",
  5: "Could not reach the server",
  6: "Protocol negotiation failed",
};

function formatIronRdpError(e: unknown): string {
  if (e && typeof e === "object" && "__wbg_ptr" in e) {
    try {
      const err = e as { kind?: () => number };
      const kind = err.kind?.();
      if (kind !== undefined && ERROR_KIND_NAMES[kind]) return ERROR_KIND_NAMES[kind];
    } catch {
      /* fall through */
    }
  }
  return e instanceof Error ? e.message : String(e);
}
