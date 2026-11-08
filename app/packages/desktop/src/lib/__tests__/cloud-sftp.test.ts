import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  cloudSftpDelete,
  cloudSftpDownload,
  cloudSftpList,
  cloudSftpMkdir,
  cloudSftpUpload,
} from "../cloud-sftp";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-sftp wrappers", () => {
  it("cloudSftpList wraps body", async () => {
    const body = { accountId: "a", path: "/" };
    await cloudSftpList("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sftp_list", { orgId: "org1", body });
  });

  it("cloudSftpMkdir", async () => {
    const body = { accountId: "a", path: "/new" };
    await cloudSftpMkdir("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sftp_mkdir", { orgId: "org1", body });
  });

  it("cloudSftpDelete", async () => {
    const body = { accountId: "a", path: "/x", isDir: true };
    await cloudSftpDelete("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sftp_delete", { orgId: "org1", body });
  });

  it("cloudSftpUpload passes params flat", async () => {
    const data = new Uint8Array([1, 2]);
    const params = { orgId: "org1", accountId: "a", remotePath: "/r", data };
    await cloudSftpUpload(params);
    expect(invoke).toHaveBeenCalledWith("cloud_sftp_upload", params);
  });

  it("cloudSftpDownload passes params flat", async () => {
    const params = {
      orgId: "org1",
      accountId: "a",
      remotePath: "/r",
      destFolder: "/l",
      relativePath: "r",
    };
    await cloudSftpDownload(params);
    expect(invoke).toHaveBeenCalledWith("cloud_sftp_download", params);
  });
});
