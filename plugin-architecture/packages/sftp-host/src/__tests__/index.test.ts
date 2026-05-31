import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { ConnectConfig } from "ssh2";

// ---- ssh2 mock -------------------------------------------------------------
// A single shared "current" fake client/sftp pair that each test configures
// before invoking the helper under test.

interface FakeSftp {
  readdir: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  rmdir: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  createWriteStream: ReturnType<typeof vi.fn>;
  createReadStream: ReturnType<typeof vi.fn>;
  fastGet: ReturnType<typeof vi.fn>;
}

class FakeClient extends EventEmitter {
  connect = vi.fn((cfg: ConnectConfig) => {
    lastConnectConfig = cfg;
    // Drive the lifecycle asynchronously, mirroring ssh2.
    queueMicrotask(() => {
      if (connectError) {
        this.emit("error", connectError);
        return;
      }
      this.emit("ready");
    });
  });
  end = vi.fn();
  sftp = vi.fn((cb: (err: Error | undefined, sftp: FakeSftp) => void) => {
    if (sftpError) {
      cb(sftpError, undefined as unknown as FakeSftp);
      return;
    }
    cb(undefined, fakeSftp);
  });
}

let fakeSftp: FakeSftp;
let lastConnectConfig: ConnectConfig | undefined;
let connectError: Error | undefined;
let sftpError: Error | undefined;
let lastClient: FakeClient;

vi.mock("ssh2", () => ({
  Client: class {
    constructor() {
      lastClient = new FakeClient();
      return lastClient as unknown as object;
    }
  },
}));

import {
  withSftp,
  sftpList,
  sftpMkdir,
  sftpDelete,
  sftpUpload,
  sftpDownload,
  sftpDownloadToBuffer,
} from "../index.js";

const config = {
  host: "example.com",
  port: 22,
  username: "root",
  privateKey: "KEY",
} as Parameters<typeof withSftp>[0];

function makeSftp(overrides: Partial<FakeSftp> = {}): FakeSftp {
  return {
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    unlink: vi.fn(),
    createWriteStream: vi.fn(),
    createReadStream: vi.fn(),
    fastGet: vi.fn(),
    ...overrides,
  };
}

function attrs(mode: number, size = 0, mtime = 0) {
  return { mode, size, mtime };
}

beforeEach(() => {
  connectError = undefined;
  sftpError = undefined;
  lastConnectConfig = undefined;
  fakeSftp = makeSftp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- withSftp / connection lifecycle --------------------------------------

describe("withSftp", () => {
  it("connects, runs fn, ends the client, resolves with fn result", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    const result = await withSftp(config, fn);
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledWith(fakeSftp);
    expect(lastClient.end).toHaveBeenCalledTimes(1);
  });

  it("rejects and ends the client when fn rejects", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fn boom"));
    await expect(withSftp(config, fn)).rejects.toThrow("fn boom");
    expect(lastClient.end).toHaveBeenCalledTimes(1);
  });

  it("rejects when sftp subsystem fails, and ends the client", async () => {
    sftpError = new Error("no sftp");
    await expect(withSftp(config, vi.fn())).rejects.toThrow("no sftp");
    expect(lastClient.end).toHaveBeenCalledTimes(1);
  });

  it("wraps connection errors with an SSH error prefix", async () => {
    connectError = new Error("auth failed");
    await expect(withSftp(config, vi.fn())).rejects.toThrow("SSH error: auth failed");
  });

  it("installs a fail-closed hostVerifier by default", async () => {
    await withSftp(config, vi.fn().mockResolvedValue(undefined));
    expect(typeof lastConnectConfig?.hostVerifier).toBe("function");
    expect(() =>
      (lastConnectConfig!.hostVerifier as (k: Buffer) => boolean)(Buffer.from("k")),
    ).toThrow(/no SSH host-key verifier configured/);
  });

  it("passes the base config through configureConnect when provided", async () => {
    const verifier = () => true;
    const configureConnect = vi.fn((opts: ConnectConfig) => ({ ...opts, hostVerifier: verifier }));
    await withSftp(config, vi.fn().mockResolvedValue(undefined), { configureConnect });
    expect(configureConnect).toHaveBeenCalledTimes(1);
    expect(lastConnectConfig?.hostVerifier).toBe(verifier);
    expect(lastConnectConfig?.host).toBe("example.com");
    expect(lastConnectConfig?.username).toBe("root");
  });
});

// ---- sftpList --------------------------------------------------------------

describe("sftpList", () => {
  it("maps entries, filters . and .., sorts dirs-first then alphabetical", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) =>
        cb(undefined, [
          { filename: ".", attrs: attrs(0o040000) },
          { filename: "..", attrs: attrs(0o040000) },
          { filename: "zeta.txt", attrs: attrs(0o100644, 10, 1700000000) },
          { filename: "alpha.txt", attrs: attrs(0o100644, 20, 1700000001) },
          { filename: "subdir", attrs: attrs(0o040755) },
        ]),
      ),
    });

    const out = await sftpList(config, "/home/root");
    expect(out.map((e) => e.name)).toEqual(["subdir", "alpha.txt", "zeta.txt"]);
    const subdir = out[0];
    expect(subdir.isDirectory).toBe(true);
    expect(subdir.key).toBe("/home/root/subdir");
    const alpha = out[1];
    expect(alpha.isDirectory).toBe(false);
    expect(alpha.size).toBe(20);
    expect(alpha.lastModified).toBe(new Date(1700000001 * 1000).toISOString());
  });

  it("handles a dir path that already ends with a slash", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) => cb(undefined, [{ filename: "f", attrs: attrs(0o100644) }])),
    });
    const out = await sftpList(config, "/root/");
    expect(out[0].key).toBe("/root/f");
  });

  it("defaults missing attrs to zero", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) => cb(undefined, [{ filename: "f", attrs: {} }])),
    });
    const out = await sftpList(config, "/r");
    expect(out[0].size).toBe(0);
    expect(out[0].isDirectory).toBe(false);
    expect(out[0].lastModified).toBe(new Date(0).toISOString());
  });

  it("rejects when readdir errors", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) => cb(new Error("EACCES"), [])),
    });
    await expect(sftpList(config, "/x")).rejects.toThrow("EACCES");
  });
});

// ---- sftpMkdir -------------------------------------------------------------

describe("sftpMkdir", () => {
  it("resolves on success", async () => {
    fakeSftp = makeSftp({ mkdir: vi.fn((_p, cb) => cb(undefined)) });
    await expect(sftpMkdir(config, "/new")).resolves.toBeUndefined();
    expect(fakeSftp.mkdir).toHaveBeenCalledWith("/new", expect.any(Function));
  });

  it("rejects on error", async () => {
    fakeSftp = makeSftp({ mkdir: vi.fn((_p, cb) => cb(new Error("EEXIST"))) });
    await expect(sftpMkdir(config, "/new")).rejects.toThrow("EEXIST");
  });
});

// ---- sftpDelete ------------------------------------------------------------

describe("sftpDelete", () => {
  it("unlinks a single file", async () => {
    fakeSftp = makeSftp({ unlink: vi.fn((_p, cb) => cb(undefined)) });
    await expect(sftpDelete(config, "/a/b.txt", false)).resolves.toBeUndefined();
    expect(fakeSftp.unlink).toHaveBeenCalledWith("/a/b.txt", expect.any(Function));
  });

  it("rejects when single-file unlink errors", async () => {
    fakeSftp = makeSftp({ unlink: vi.fn((_p, cb) => cb(new Error("ENOENT"))) });
    await expect(sftpDelete(config, "/a/b.txt", false)).rejects.toThrow("ENOENT");
  });

  it("recursively removes a directory tree (files + nested dirs)", async () => {
    // /dir contains: file1, nested/ ; nested/ contains: file2
    const readdir = vi.fn((p: string, cb: (e: Error | undefined, l: unknown[]) => void) => {
      if (p === "/dir") {
        cb(undefined, [
          { filename: ".", attrs: attrs(0o040000) },
          { filename: "file1", attrs: attrs(0o100644) },
          { filename: "nested", attrs: attrs(0o040755) },
        ]);
      } else if (p === "/dir/nested") {
        cb(undefined, [{ filename: "file2", attrs: attrs(0o100644) }]);
      } else {
        cb(new Error(`unexpected path ${p}`), []);
      }
    });
    const unlink = vi.fn((_p, cb) => cb(undefined));
    const rmdir = vi.fn((_p, cb) => cb(undefined));
    fakeSftp = makeSftp({ readdir, unlink, rmdir });

    await expect(sftpDelete(config, "/dir", true)).resolves.toBeUndefined();
    expect(unlink.mock.calls.map((c) => c[0]).sort()).toEqual(["/dir/file1", "/dir/nested/file2"]);
    // rmdir called for nested first, then /dir
    expect(rmdir.mock.calls.map((c) => c[0])).toEqual(["/dir/nested", "/dir"]);
  });

  it("rejects when recursive readdir errors", async () => {
    fakeSftp = makeSftp({ readdir: vi.fn((_p, cb) => cb(new Error("EACCES"), [])) });
    await expect(sftpDelete(config, "/dir", true)).rejects.toThrow("EACCES");
  });

  it("rejects when an unlink inside recursion errors", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) => cb(undefined, [{ filename: "f", attrs: attrs(0o100644) }])),
      unlink: vi.fn((_p, cb) => cb(new Error("unlink fail"))),
    });
    await expect(sftpDelete(config, "/dir", true)).rejects.toThrow("unlink fail");
  });

  it("rejects when the final rmdir errors", async () => {
    fakeSftp = makeSftp({
      readdir: vi.fn((_p, cb) => cb(undefined, [])),
      rmdir: vi.fn((_p, cb) => cb(new Error("rmdir fail"))),
    });
    await expect(sftpDelete(config, "/dir", true)).rejects.toThrow("rmdir fail");
  });
});

// ---- sftpUpload ------------------------------------------------------------

describe("sftpUpload", () => {
  it("writes the buffer and resolves on stream close", async () => {
    const stream = new EventEmitter() as EventEmitter & { end: (d: Buffer) => void };
    stream.end = vi.fn((_d: Buffer) => {
      queueMicrotask(() => stream.emit("close"));
    });
    fakeSftp = makeSftp({ createWriteStream: vi.fn(() => stream) });

    const data = Buffer.from("hello");
    await expect(sftpUpload(config, "/up.txt", data)).resolves.toBeUndefined();
    expect(stream.end).toHaveBeenCalledWith(data);
  });

  it("rejects when the write stream errors", async () => {
    const stream = new EventEmitter() as EventEmitter & { end: (d: Buffer) => void };
    stream.end = vi.fn(() => {
      queueMicrotask(() => stream.emit("error", new Error("write boom")));
    });
    fakeSftp = makeSftp({ createWriteStream: vi.fn(() => stream) });
    await expect(sftpUpload(config, "/up.txt", Buffer.from("x"))).rejects.toThrow("write boom");
  });
});

// ---- sftpDownload ----------------------------------------------------------

describe("sftpDownload", () => {
  it("creates the local dir and fastGets the remote file", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    fakeSftp = makeSftp({ fastGet: vi.fn((_r, _l, cb) => cb(undefined)) });

    await expect(
      sftpDownload(config, "/remote.txt", "/tmp/local/out.txt"),
    ).resolves.toBeUndefined();
    expect(mkdirSpy).toHaveBeenCalledWith("/tmp/local", { recursive: true });
    expect(fakeSftp.fastGet).toHaveBeenCalledWith(
      "/remote.txt",
      "/tmp/local/out.txt",
      expect.any(Function),
    );
  });

  it("rejects when fastGet errors", async () => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    fakeSftp = makeSftp({ fastGet: vi.fn((_r, _l, cb) => cb(new Error("download boom"))) });
    await expect(sftpDownload(config, "/r", "/tmp/x/o")).rejects.toThrow("download boom");
  });
});

// ---- sftpDownloadToBuffer --------------------------------------------------

describe("sftpDownloadToBuffer", () => {
  it("concatenates chunks into a single buffer on end", async () => {
    const stream = new EventEmitter();
    fakeSftp = makeSftp({ createReadStream: vi.fn(() => stream) });

    const promise = sftpDownloadToBuffer(config, "/r.bin");
    // wait a tick so the read stream listeners are attached
    await Promise.resolve();
    stream.emit("data", Buffer.from("foo"));
    stream.emit("data", Buffer.from("bar"));
    stream.emit("end");

    const buf = await promise;
    expect(buf.toString()).toBe("foobar");
  });

  it("rejects when the read stream errors", async () => {
    const stream = new EventEmitter();
    fakeSftp = makeSftp({ createReadStream: vi.fn(() => stream) });
    const promise = sftpDownloadToBuffer(config, "/r.bin");
    await Promise.resolve();
    stream.emit("error", new Error("read boom"));
    await expect(promise).rejects.toThrow("read boom");
  });
});
