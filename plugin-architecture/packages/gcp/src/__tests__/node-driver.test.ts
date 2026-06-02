import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { EventEmitter, Readable } from "node:stream";

/** Minimal response shape used by the callback in `https.get(url, opts, cb)`. */
type HttpsGetCallback = (res: Readable & { statusCode: number; resume?: () => void }) => void;

const mockMkdirSync = vi.fn();
const mockCreateWriteStream = vi.fn();
const mockUnlink = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
}));

const mockHttpsGet = vi.fn();

vi.mock("node:https", () => ({
  default: {
    get: (...args: unknown[]) => mockHttpsGet(...args),
  },
}));

import { nodeDriver } from "../node-driver.js";

function createMockResponse(statusCode: number): Readable & { statusCode: number } {
  const res = new Readable({ read() {} }) as Readable & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

function createMockWriteStream(): EventEmitter & { close: Mock } {
  const ws = new EventEmitter() as EventEmitter & { close: Mock };
  ws.close = vi.fn();
  return ws;
}

describe("gcp node-driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has pluginId 'gcp'", () => {
    expect(nodeDriver.pluginId).toBe("gcp");
  });

  describe("downloadFile", () => {
    it("downloads file successfully on HTTP 200", async () => {
      const mockRes = createMockResponse(200);
      const mockWs = createMockWriteStream();

      mockCreateWriteStream.mockReturnValue(mockWs);
      mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        setTimeout(() => {
          cb(mockRes);
          // Simulate pipe by emitting finish on the write stream
          mockRes.pipe = vi.fn(() => {
            setTimeout(() => mockWs.emit("finish"), 0);
            return mockWs;
          }) as unknown as Readable["pipe"];
          cb(mockRes);
        }, 0);
        return req;
      });

      // Re-implement more directly: the actual implementation calls https.get with a callback
      mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        const res = createMockResponse(200);
        res.pipe = vi.fn(() => {
          process.nextTick(() => mockWs.emit("finish"));
          return mockWs;
        }) as unknown as Readable["pipe"];
        process.nextTick(() => cb(res));
        return req;
      });

      const promise = nodeDriver.downloadFile(
        "my-bucket",
        "path/to/file.txt",
        "token123",
        "/tmp/dest/file.txt",
      );

      await promise;

      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/dest", { recursive: true });
      expect(mockCreateWriteStream).toHaveBeenCalledWith("/tmp/dest/file.txt");
      expect(mockWs.close).toHaveBeenCalled();
    });

    it("rejects on non-200 status code", async () => {
      mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        const res = createMockResponse(403);
        res.resume = vi.fn();
        process.nextTick(() => cb(res));
        return req;
      });

      await expect(
        nodeDriver.downloadFile("my-bucket", "key", "token", "/tmp/file"),
      ).rejects.toThrow("HTTP 403");
    });

    it("rejects on request error", async () => {
      mockHttpsGet.mockImplementation(() => {
        const req = new EventEmitter();
        process.nextTick(() => req.emit("error", new Error("connection refused")));
        return req;
      });

      await expect(
        nodeDriver.downloadFile("my-bucket", "key", "token", "/tmp/file"),
      ).rejects.toThrow("connection refused");
    });

    it("rejects on write stream error and cleans up file", async () => {
      const mockWs = createMockWriteStream();
      mockCreateWriteStream.mockReturnValue(mockWs);

      mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        const res = createMockResponse(200);
        res.pipe = vi.fn(() => {
          process.nextTick(() => mockWs.emit("error", new Error("disk full")));
          return mockWs;
        }) as unknown as Readable["pipe"];
        process.nextTick(() => cb(res));
        return req;
      });

      await expect(
        nodeDriver.downloadFile("my-bucket", "key", "token", "/tmp/file"),
      ).rejects.toThrow("disk full");
      expect(mockUnlink).toHaveBeenCalledWith("/tmp/file", expect.any(Function));
    });

    it("constructs correct GCS URL with encoded bucket and key", async () => {
      const mockWs = createMockWriteStream();
      mockCreateWriteStream.mockReturnValue(mockWs);

      mockHttpsGet.mockImplementation((url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        const res = createMockResponse(200);
        res.pipe = vi.fn(() => {
          process.nextTick(() => mockWs.emit("finish"));
          return mockWs;
        }) as unknown as Readable["pipe"];
        process.nextTick(() => cb(res));
        return req;
      });

      await nodeDriver.downloadFile("my-bucket", "path/to/file.txt", "tok", "/tmp/f");

      const calledUrl = mockHttpsGet.mock.calls[0]![0] as string;
      expect(calledUrl).toContain("my-bucket");
      expect(calledUrl).toContain(encodeURIComponent("path/to/file.txt"));
      expect(calledUrl).toContain("alt=media");
    });

    it("passes Authorization header with bearer token", async () => {
      const mockWs = createMockWriteStream();
      mockCreateWriteStream.mockReturnValue(mockWs);

      mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: HttpsGetCallback) => {
        const req = new EventEmitter();
        const res = createMockResponse(200);
        res.pipe = vi.fn(() => {
          process.nextTick(() => mockWs.emit("finish"));
          return mockWs;
        }) as unknown as Readable["pipe"];
        process.nextTick(() => cb(res));
        return req;
      });

      await nodeDriver.downloadFile("bucket", "key", "mytoken", "/tmp/f");

      const opts = mockHttpsGet.mock.calls[0]![1] as { headers: { Authorization: string } };
      expect(opts.headers.Authorization).toBe("Bearer mytoken");
    });
  });
});
