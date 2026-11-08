import type { StorageObject } from "@infrawrench/plugin-base";
import { cloudClient } from "./cloud-client";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/** Which account's host to reach, and the SSH overrides a cloud key brings. */
interface CloudSftpTarget {
  accountId: string;
  /** Accepted for the callers' convenience; the SFTP routes resolve the host from the account. */
  resourceId?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}

/** The SSH overrides that are set, as the contract's optional keys. */
const sshOverrides = (target: Omit<CloudSftpTarget, "accountId" | "resourceId">) => ({
  ...(target.sshKeyId !== undefined ? { sshKeyId: target.sshKeyId } : {}),
  ...(target.sshHost !== undefined ? { sshHost: target.sshHost } : {}),
  ...(target.sshUsername !== undefined ? { sshUsername: target.sshUsername } : {}),
});

const connections = cloudClient("connections").connections;

export function cloudSftpList(
  orgId: string,
  body: CloudSftpTarget & { path: string },
): Promise<StorageObject[]> {
  return runRpc(
    connections.sftpList({
      params: { orgId },
      payload: { accountId: body.accountId, path: body.path, ...sshOverrides(body) },
    }),
  );
}

export async function cloudSftpMkdir(
  orgId: string,
  body: CloudSftpTarget & { path: string },
): Promise<void> {
  await runRpc(
    connections.sftpMkdir({
      params: { orgId },
      payload: { accountId: body.accountId, path: body.path, ...sshOverrides(body) },
    }),
  );
}

export async function cloudSftpDelete(
  orgId: string,
  body: CloudSftpTarget & { path: string; isDir?: boolean },
): Promise<void> {
  await runRpc(
    connections.sftpDelete({
      params: { orgId },
      payload: {
        accountId: body.accountId,
        path: body.path,
        isDir: body.isDir ?? false,
        ...sshOverrides(body),
      },
    }),
  );
}

/**
 * A multipart upload, sent by the main process (`CloudSftpUpload`), which
 * prompts for the host key when the server asks.
 */
export function cloudSftpUpload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  data: Uint8Array;
  filename?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudSftpUpload(params)));
}

/**
 * One file written to disk by the main process (`CloudSftpDownload`); the
 * bytes never reach the renderer. A reload midway cancels it and leaves no
 * partial file.
 */
export function cloudSftpDownload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  /** Folder the user picked via `showOpenDialog`; main rejects anything else. */
  destFolder: string;
  /** Path beneath `destFolder`, `/`-separated; main rejects `..`, `\\`, `:` and absolutes. */
  relativePath: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudSftpDownload(params)));
}

export function cloudSshTunnelExec(
  orgId: string,
  body: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    command: string;
  },
): Promise<{ stdout: string; stderr?: string; code: number }> {
  return runRpc(cloudClient("sshTunnels").sshTunnels.exec({ params: { orgId }, payload: body }));
}

export async function cloudSshTunnelCreateAccount(
  orgId: string,
  body: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    remoteHost: string;
    remotePort: number;
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
  },
): Promise<{ accountId: string }> {
  return runRpc(
    cloudClient("sshTunnels").sshTunnels.createAccount({ params: { orgId }, payload: body }),
  );
}
