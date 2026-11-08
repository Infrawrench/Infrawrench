/**
 * The cloud SSH operations end to end (`CloudSshRpcs`: the SFTP upload, the
 * SFTP download to disk, the host-key prompt on its own), through the real
 * RPC server and the cloud transport's session and prompt. Only the edges
 * are fakes: `fetch`, the token store and the prompt's answer. Downloads land
 * in a real temporary folder.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";

const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  forceRefreshAccessToken: vi.fn<() => Promise<string | null>>(),
  prompt: vi.fn<(input: { host: string; kind: string }) => Promise<boolean>>(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "" },
  };
});
vi.mock("../cloud-tokens", () => ({
  getAccessToken: h.getAccessToken,
  forceRefreshAccessToken: h.forceRefreshAccessToken,
}));
vi.mock("../ssh-host-key-prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ssh-host-key-prompt")>()),
  promptHostKeyDecision: h.prompt,
}));

const { callDesktopRpc, failureOf, fakeRenderer } = await import("./rpc-harness");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { registerDialogBlessedPath } = await import("../main-utils");
const { CLOUD_URL } = await import("../../env");

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const trustRequired = {
  error: "ssh_host_key_trust_required",
  message: "Unknown host key",
  kind: "unknown",
  host: "bastion.example.test",
  port: 22,
  presentedFingerprint: "SHA256:abc",
  storedFingerprint: null,
};

/** The `fetch` calls the main process made, as `[method, url, authorization]`. */
function sent() {
  return h.fetch.mock.calls.map(([url, init]) => [
    init.method ?? "GET",
    url,
    new Headers(init.headers).get("Authorization"),
  ]);
}

/** The multipart form of the `n`th call, as its text fields and its file. */
async function formOf(n: number) {
  const body = h.fetch.mock.calls[n]?.[1].body;
  if (!(body instanceof FormData)) throw new Error(`call ${n} sent no form`);
  const fields: Record<string, string> = {};
  let file: { name: string; bytes: number[] } | undefined;
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") fields[name] = value;
    else file = { name: value.name, bytes: [...new Uint8Array(await value.arrayBuffer())] };
  }
  return { fields, file };
}

const waitFor = (check: () => void) => Effect.promise(() => vi.waitFor(check));

let folder: string;

beforeEach(() => {
  vi.stubGlobal("fetch", h.fetch);
  h.getAccessToken.mockResolvedValue("access-1");
  h.forceRefreshAccessToken.mockResolvedValue("access-2");
  folder = mkdtempSync(join(tmpdir(), "iw-cloud-sftp-"));
  registerDialogBlessedPath(folder);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  rmSync(folder, { recursive: true, force: true });
});

const upload = (overrides: Record<string, string> = {}) =>
  DesktopRpcClient.use((rpc) =>
    rpc.CloudSftpUpload({
      orgId: ORG,
      accountId: ACCOUNT,
      remotePath: "/tmp/notes.txt",
      data: new Uint8Array([104, 105]),
      ...overrides,
    }),
  );

const download = (relativePath = "logs/app.log", destFolder = folder) =>
  DesktopRpcClient.use((rpc) =>
    rpc.CloudSftpDownload({
      orgId: ORG,
      accountId: ACCOUNT,
      remotePath: "/var/log/app.log",
      destFolder,
      relativePath,
      sshKeyId: "33333333-3333-4333-8333-333333333333",
    }),
  );

const uploadUrl = `${CLOUD_URL}/api/org/${ORG}/v1/sftp/upload`;
const trustUrl = `${CLOUD_URL}/api/org/${ORG}/ssh-host-keys/trust`;

describe("CloudSftpUpload", () => {
  it("posts the multipart form with the session token", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { ok: true }));

    await callDesktopRpc(upload({ sshHost: "10.0.0.5", sshUsername: "ubuntu" }));

    expect(sent()).toEqual([["POST", uploadUrl, "Bearer access-1"]]);
    expect(await formOf(0)).toEqual({
      fields: {
        accountId: ACCOUNT,
        remotePath: "/tmp/notes.txt",
        sshHost: "10.0.0.5",
        sshUsername: "ubuntu",
      },
      file: { name: "notes.txt", bytes: [104, 105] },
    });
  });

  it("refreshes the token once on a 401 and sends the form again", async () => {
    h.fetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await callDesktopRpc(upload({ filename: "renamed.txt" }));

    expect(sent().map(([, , auth]) => auth)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect((await formOf(1)).file).toEqual({ name: "renamed.txt", bytes: [104, 105] });
  });

  it("trusts the key the user accepted and sends a fresh form", async () => {
    h.prompt.mockResolvedValueOnce(true);
    h.fetch
      .mockResolvedValueOnce(json(409, trustRequired))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await callDesktopRpc(upload());

    expect(h.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ host: "bastion.example.test", kind: "first-connect" }),
    );
    expect(sent()).toEqual([
      ["POST", uploadUrl, "Bearer access-1"],
      ["POST", trustUrl, "Bearer access-1"],
      ["POST", uploadUrl, "Bearer access-1"],
    ]);
    expect(h.fetch.mock.calls[1]?.[1].body).toBe(
      JSON.stringify({ host: "bastion.example.test", port: 22, fingerprint: "SHA256:abc" }),
    );
    expect((await formOf(2)).file).toEqual({ name: "notes.txt", bytes: [104, 105] });
  });

  it("fails with the server's answer when the user declines", async () => {
    h.prompt.mockResolvedValueOnce(false);
    h.fetch.mockResolvedValueOnce(json(409, trustRequired));

    const error = await failureOf(upload());

    expect(error).toMatchObject({
      _tag: "CloudRequestError",
      message: `Upload failed: 409 ${JSON.stringify(trustRequired)}`,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when signed out", async () => {
    h.getAccessToken.mockResolvedValueOnce(null);

    const error = await failureOf(upload());

    expect(error.message).toBe("Not authenticated to Infrawrench Cloud");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses an org id that is not one path segment before sending", async () => {
    // The payload schema refuses it on both ends; the renderer's client already does.
    await expect(callDesktopRpc(upload({ orgId: ".." }))).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("CloudSftpDownload", () => {
  const downloadUrl = `${CLOUD_URL}/api/org/${ORG}/v1/sftp/download?${new URLSearchParams({
    accountId: ACCOUNT,
    paths: JSON.stringify(["/var/log/app.log"]),
    sshKeyId: "33333333-3333-4333-8333-333333333333",
  })}`;

  it("writes the file under the picked folder and leaves nothing else", async () => {
    h.fetch.mockResolvedValueOnce(new Response("line 1\nline 2\n", { status: 200 }));

    await callDesktopRpc(download());

    expect(sent()).toEqual([["GET", downloadUrl, "Bearer access-1"]]);
    expect(readFileSync(join(folder, "logs", "app.log"), "utf8")).toBe("line 1\nline 2\n");
    expect(readdirSync(join(folder, "logs"))).toEqual(["app.log"]);
  });

  it("refreshes the token once on a 401", async () => {
    h.fetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("data", { status: 200 }));

    await callDesktopRpc(download("app.log"));

    expect(sent().map(([, , auth]) => auth)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(readFileSync(join(folder, "app.log"), "utf8")).toBe("data");
  });

  it("trusts the key the user accepted and downloads on the retry", async () => {
    h.prompt.mockResolvedValueOnce(true);
    h.fetch
      .mockResolvedValueOnce(json(409, trustRequired))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(new Response("data", { status: 200 }));

    await callDesktopRpc(download("app.log"));

    expect(sent()).toEqual([
      ["GET", downloadUrl, "Bearer access-1"],
      ["POST", trustUrl, "Bearer access-1"],
      ["GET", downloadUrl, "Bearer access-1"],
    ]);
    expect(readFileSync(join(folder, "app.log"), "utf8")).toBe("data");
  });

  it("fails without writing when the user declines the key", async () => {
    h.prompt.mockResolvedValueOnce(false);
    h.fetch.mockResolvedValueOnce(json(409, trustRequired));

    const error = await failureOf(download("app.log"));

    expect(error.message).toBe(`Download failed: 409 ${JSON.stringify(trustRequired)}`);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("refuses a folder no dialog picked, and an unsafe relative path, before fetching", async () => {
    const unpicked = await failureOf(download("app.log", join(tmpdir(), "elsewhere")));
    expect(unpicked.message).toBe("Download destination was not chosen via a system dialog");

    const unsafe = await failureOf(download("../escape.log"));
    expect(unsafe.message).toContain("Refusing to write unsafe download path");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  describe("cancelled midway", () => {
    /** A body that sends one chunk and then waits, recording whether it was cancelled. */
    function hangingBody() {
      const state = { cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, response: new Response(body, { status: 200 }) };
    }

    const partialWritten = () => {
      const [entry] = readdirSync(folder);
      expect(entry).toMatch(/^\.app\.log\..+\.part$/);
      expect(readFileSync(join(folder, entry!), "utf8")).toBe("partial");
    };

    it("by the renderer interrupting the call: aborts and removes the partial file", async () => {
      const { state, response } = hangingBody();
      h.fetch.mockResolvedValueOnce(response);

      await callDesktopRpc(
        Effect.gen(function* () {
          const fiber = yield* download("app.log").pipe(Effect.forkChild);
          yield* waitFor(partialWritten);
          yield* Fiber.interrupt(fiber);
          yield* waitFor(() => {
            expect(state.cancelled).toBe(true);
            expect(readdirSync(folder)).toEqual([]);
          });
        }),
      );
    });

    it("by the renderer going away (a reload): aborts and removes the partial file", async () => {
      const { state, response } = hangingBody();
      h.fetch.mockResolvedValueOnce(response);
      const renderer = fakeRenderer();

      // The call is left waiting for an answer that never comes (the
      // connection is gone); the server is torn down when this effect ends.
      await callDesktopRpc(
        Effect.gen(function* () {
          yield* download("app.log").pipe(Effect.forkChild);
          yield* waitFor(partialWritten);
          renderer.destroy();
          yield* waitFor(() => {
            expect(state.cancelled).toBe(true);
            expect(readdirSync(folder)).toEqual([]);
          });
        }),
        renderer,
      );
    });
  });
});

describe("CloudSshHostKeyTrust", () => {
  const trust = (storedFingerprint: string | null = "SHA256:old") =>
    DesktopRpcClient.use((rpc) =>
      rpc.CloudSshHostKeyTrust({
        orgId: ORG,
        host: "bastion.example.test",
        port: 2222,
        kind: "mismatch",
        presentedFingerprint: "SHA256:new",
        storedFingerprint,
      }),
    );

  it("records the key the user accepted and answers true", async () => {
    h.prompt.mockResolvedValueOnce(true);
    h.fetch.mockResolvedValueOnce(json(200, { ok: true }));

    expect(await callDesktopRpc(trust())).toBe(true);

    expect(h.prompt).toHaveBeenCalledWith({
      host: "bastion.example.test",
      port: 2222,
      kind: "mismatch",
      presentedFingerprint: "SHA256:new",
      storedFingerprint: "SHA256:old",
    });
    expect(sent()).toEqual([["POST", trustUrl, "Bearer access-1"]]);
    expect(h.fetch.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({
        host: "bastion.example.test",
        port: 2222,
        fingerprint: "SHA256:new",
        previousFingerprint: "SHA256:old",
      }),
    );
  });

  it("answers false without a request when the user declines", async () => {
    h.prompt.mockResolvedValueOnce(false);

    expect(await callDesktopRpc(trust())).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refreshes the token once on a 401, and answers false when the trust is refused", async () => {
    h.prompt.mockResolvedValue(true);
    h.fetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    expect(await callDesktopRpc(trust(null))).toBe(true);
    expect(sent().map(([, , auth]) => auth)).toEqual(["Bearer access-1", "Bearer access-2"]);

    h.fetch.mockResolvedValueOnce(json(403, { error: "Forbidden" }));
    expect(await callDesktopRpc(trust(null))).toBe(false);
  });
});
