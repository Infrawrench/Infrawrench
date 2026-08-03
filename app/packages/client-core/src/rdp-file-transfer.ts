// RDP file transfer over the CLIPRDR clipboard channel — the platform-neutral
// protocol half, shared by the desktop and web RDP viewers.
//
// Upload  (local → remote): the user copies files locally, the client advertises
//   them to the remote clipboard, and the remote pastes to pull the bytes. We
//   serve file size and ranged reads from an `RdpUploadFile` on demand.
// Download (remote → local): the remote copies files, IronRDP raises
//   `files_available_callback`; we request size then contents, accumulate the
//   chunks, and hand the assembled bytes to an `RdpFileSink`.
//
// The two hosts differ only in I/O, injected as adapters: desktop reads/writes
// through Electron IPC (dialog-blessed paths); web reads from a browser `File`
// and saves via a download. `Extension`/`Session` are passed in so this module
// never imports ironrdp-wasm (each renderer loads it dynamically).

/** A file the user chose to upload; `read` returns the requested byte range. */
export interface RdpUploadFile {
  name: string;
  size: number;
  lastModified?: number;
  read(position: number, length: number): Promise<Uint8Array>;
}

/** Where a downloaded remote file is written. */
export interface RdpFileSink {
  save(name: string, bytes: Uint8Array): Promise<{ saved: boolean; path?: string }>;
}

interface IronRdpExtension {
  new (ident: string, value: unknown): unknown;
}

interface IronRdpSession {
  invokeExtension(ext: unknown): unknown;
}

interface RemoteFileDescriptor {
  name: string;
  size?: number;
  [key: string]: unknown;
}

interface PendingDownload extends RemoteFileDescriptor {
  clipDataId: unknown;
}

interface DownloadState extends PendingDownload {
  _fileIndex: number;
  _chunks?: Uint8Array[];
  _totalSize?: number;
  _expectedSize?: number;
  _sizeReceived?: boolean;
}

type Logger = (message: string, level?: "info" | "warn" | "error" | "success") => void;

// CLIPRDR FILECONTENTS_REQUEST flags.
const FLAG_SIZE = 0x00000001;
const FLAG_RANGE = 0x00000002;

export interface RdpFileTransferCallbacks {
  onRemoteFilesChanged: (hasRemoteFiles: boolean) => void;
  onUploadInProgress: (inProgress: boolean) => void;
  onDownloadComplete: (savedPath: string, name: string, size: number) => void;
}

export class RdpFileTransferManager {
  #getSession: () => IronRdpSession | null;
  #Extension: IronRdpExtension;
  #log: Logger;
  #cb: RdpFileTransferCallbacks;
  #sink: RdpFileSink;

  #uploadedFiles = new Map<number, RdpUploadFile>();
  #pendingDownloads = new Map<number, PendingDownload>();
  #streamToFile = new Map<number, DownloadState>();

  constructor(
    getSession: () => IronRdpSession | null,
    Extension: IronRdpExtension,
    log: Logger,
    callbacks: RdpFileTransferCallbacks,
    sink: RdpFileSink,
  ) {
    this.#getSession = getSession;
    this.#Extension = Extension;
    this.#log = log;
    this.#cb = callbacks;
    this.#sink = sink;
  }

  /** Extensions to register on the SessionBuilder for two-way file transfer. */
  createExtensions(): unknown[] {
    const E = this.#Extension;
    return [
      new E("files_available_callback", (files: RemoteFileDescriptor[], clipDataId: unknown) => {
        this.#pendingDownloads.clear();
        this.#streamToFile.clear();
        if (files && files.length > 0) {
          files.forEach((f, i) => this.#pendingDownloads.set(i, { ...f, clipDataId }));
        }
        this.#cb.onRemoteFilesChanged(Boolean(files && files.length > 0));
      }),
      new E(
        "file_contents_request_callback",
        async (request: {
          index: number;
          streamId: number;
          flags: number;
          position: number;
          size: number;
        }) => {
          const file = this.#uploadedFiles.get(request.index);
          const session = this.#getSession();
          if (!file || !session) {
            session?.invokeExtension(
              new E("submit_file_contents", {
                stream_id: request.streamId,
                is_error: true,
                data: new Uint8Array(0),
              }),
            );
            return;
          }
          try {
            if (request.flags & FLAG_SIZE) {
              const sizeBytes = new Uint8Array(8);
              new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(file.size), true);
              session.invokeExtension(
                new E("submit_file_contents", {
                  stream_id: request.streamId,
                  is_error: false,
                  data: sizeBytes,
                }),
              );
            } else if (request.flags & FLAG_RANGE) {
              const data = await file.read(request.position, request.size);
              session.invokeExtension(
                new E("submit_file_contents", {
                  stream_id: request.streamId,
                  is_error: false,
                  data,
                }),
              );
              this.#cb.onUploadInProgress(false);
            }
          } catch (e) {
            this.#log(`Failed to read file for upload: ${errMsg(e)}`, "error");
            session.invokeExtension(
              new E("submit_file_contents", {
                stream_id: request.streamId,
                is_error: true,
                data: new Uint8Array(0),
              }),
            );
            this.#cb.onUploadInProgress(false);
          }
        },
      ),
      new E(
        "file_contents_response_callback",
        (response: { streamId: number; isError: boolean; data: Uint8Array }) => {
          this.#onContentsResponse(response);
        },
      ),
      new E("lock_callback", () => {}),
      new E("unlock_callback", () => {}),
      new E("locks_expired_callback", () => {}),
    ];
  }

  #onContentsResponse(response: { streamId: number; isError: boolean; data: Uint8Array }): void {
    const info = this.#streamToFile.get(response.streamId);
    if (!info) return;
    if (response.isError) {
      this.#streamToFile.delete(response.streamId);
      return;
    }
    if (!info._chunks) {
      info._chunks = [];
      info._totalSize = 0;
    }
    // First reply to a FLAG_SIZE request is the 8-byte little-endian size.
    if (response.data.length === 8 && !info._sizeReceived) {
      const fileSize = Number(new DataView(response.data.buffer).getBigUint64(0, true));
      info._sizeReceived = true;
      info._expectedSize = fileSize;
      const dataStreamId = response.streamId + 1000;
      this.#streamToFile.set(dataStreamId, info);
      this.#getSession()?.invokeExtension(
        new this.#Extension("request_file_contents", {
          stream_id: dataStreamId,
          file_index: info._fileIndex,
          flags: FLAG_RANGE,
          position: 0,
          size: fileSize,
          clip_data_id: info.clipDataId,
        }),
      );
      return;
    }
    info._chunks.push(new Uint8Array(response.data));
    info._totalSize = (info._totalSize ?? 0) + response.data.length;
    if (info._totalSize >= (info._expectedSize ?? 0)) {
      void this.#saveDownload(info);
      this.#streamToFile.delete(response.streamId);
    }
  }

  async #saveDownload(info: DownloadState): Promise<void> {
    try {
      const total = info._totalSize ?? 0;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of info._chunks ?? []) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const result = await this.#sink.save(info.name, merged);
      if (result.saved) {
        this.#log(`Downloaded ${info.name} (${total} bytes)`, "success");
        this.#pendingDownloads.clear();
        this.#cb.onRemoteFilesChanged(false);
        this.#cb.onDownloadComplete(result.path ?? info.name, info.name, total);
      }
    } catch (e) {
      this.#log(`Failed to save downloaded file: ${errMsg(e)}`, "error");
    }
  }

  /** Advertise chosen local files to the remote clipboard for upload. */
  uploadFiles(files: RdpUploadFile[]): void {
    const session = this.#getSession();
    if (!session) {
      this.#log("File transfer not available — no active session", "error");
      return;
    }
    if (files.length === 0) return;
    this.#cb.onUploadInProgress(true);
    this.#uploadedFiles.clear();
    const descriptors = files.map((file, index) => {
      this.#uploadedFiles.set(index, file);
      return { name: file.name, size: file.size, lastModified: file.lastModified ?? 0 };
    });
    try {
      session.invokeExtension(new this.#Extension("initiate_file_copy", descriptors));
    } catch (e) {
      this.#log(`Failed to start file copy: ${errMsg(e)}`, "error");
      this.#cb.onUploadInProgress(false);
    }
  }

  /** Pull the files the remote has copied to its clipboard down to disk. */
  downloadFiles(): void {
    const session = this.#getSession();
    if (!session) {
      this.#log("File transfer not available — no active session", "error");
      return;
    }
    if (this.#pendingDownloads.size === 0) {
      this.#log("No files available for download", "info");
      return;
    }
    this.#pendingDownloads.forEach((fileInfo, index) => {
      try {
        const sizeStreamId = index + 1;
        this.#streamToFile.set(sizeStreamId, { ...fileInfo, _fileIndex: index });
        session.invokeExtension(
          new this.#Extension("request_file_contents", {
            stream_id: sizeStreamId,
            file_index: index,
            flags: FLAG_SIZE,
            position: 0,
            size: 8,
            clip_data_id: fileInfo.clipDataId,
          }),
        );
      } catch (e) {
        this.#log(`Failed to request ${fileInfo.name}: ${errMsg(e)}`, "error");
      }
    });
  }

  cleanup(): void {
    this.#uploadedFiles.clear();
    this.#pendingDownloads.clear();
    this.#streamToFile.clear();
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
