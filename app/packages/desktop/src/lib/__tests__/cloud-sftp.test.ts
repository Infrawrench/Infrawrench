/**
 * The cloud SFTP wrappers: list, mkdir and delete on the cloud transport
 * (`CloudHttp`, through the `connections` contract client), upload and
 * download on the main process's own operations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, fakeRpc, resetFakeRpc } = await import("./fake-rpc");
const { cloudSftpDelete, cloudSftpDownload, cloudSftpList, cloudSftpMkdir, cloudSftpUpload } =
  await import("../cloud-sftp");
const { CloudRequestError } = await import("../../../shared/rpc/errors");

beforeEach(() => {
  resetFakeRpc();
});

/** The one request sent, with its JSON body parsed. */
function sent(http: ReturnType<typeof answerCloudHttp>) {
  expect(http).toHaveBeenCalledTimes(1);
  const request = http.mock.calls[0]![0];
  return { ...request, body: request.body === undefined ? undefined : JSON.parse(request.body) };
}

describe("cloud-sftp wrappers", () => {
  it("cloudSftpList posts the listing request and answers the entries", async () => {
    const entries = [
      { key: "/etc", name: "etc", size: 0, lastModified: "2026-11-01", isDirectory: true },
    ];
    const http = answerCloudHttp(() => ({ status: 200, json: entries }));

    const answer = await cloudSftpList("org1", {
      accountId: "a",
      resourceId: "r",
      path: "/",
      sshKeyId: "k",
      sshHost: "h",
    });

    expect(answer).toEqual(entries);
    // `resourceId` is not part of the route's body; the server resolves the host from the account.
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org1/sftp/list",
      body: { accountId: "a", path: "/", sshKeyId: "k", sshHost: "h" },
    });
  });

  it("cloudSftpMkdir", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await cloudSftpMkdir("org1", { accountId: "a", path: "/new" });
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org1/sftp/mkdir",
      body: { accountId: "a", path: "/new" },
    });
  });

  it("cloudSftpDelete sends isDir, false unless stated", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await cloudSftpDelete("org1", { accountId: "a", path: "/x", isDir: true });
    expect(sent(http).body).toEqual({ accountId: "a", path: "/x", isDir: true });

    http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await cloudSftpDelete("org1", { accountId: "a", path: "/y" });
    expect(sent(http).body).toEqual({ accountId: "a", path: "/y", isDir: false });
  });

  it("fails with the transport's sentence on an error status", async () => {
    answerCloudHttp(() => ({ status: 500, json: { error: "SFTP list failed" } }));
    await expect(cloudSftpList("org1", { accountId: "a", path: "/" })).rejects.toThrow(
      'Cloud request failed: 500 /sftp/list {"error":"SFTP list failed"}',
    );
  });

  it("cloudSftpUpload hands the params to CloudSftpUpload", async () => {
    const upload = vi.fn((_input: unknown) => Effect.void);
    fakeRpc["CloudSftpUpload"] = upload;
    const params = {
      orgId: "org1",
      accountId: "a",
      remotePath: "/r",
      data: new Uint8Array([1, 2]),
    };
    await cloudSftpUpload(params);
    expect(upload).toHaveBeenCalledWith(params);
  });

  it("cloudSftpDownload hands the params to CloudSftpDownload and rejects with its error", async () => {
    const download = vi.fn((_input: unknown) =>
      Effect.fail(new CloudRequestError({ message: "Download failed: 404 nope" })),
    );
    fakeRpc["CloudSftpDownload"] = download;
    const params = {
      orgId: "org1",
      accountId: "a",
      remotePath: "/r",
      destFolder: "/l",
      relativePath: "r",
    };
    await expect(cloudSftpDownload(params)).rejects.toThrow("Download failed: 404 nope");
    expect(download).toHaveBeenCalledWith(params);
  });
});
