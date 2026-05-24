import { invoke } from "./invoke";

export async function cloudSftpList(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<unknown> {
  return invoke("cloud_sftp_list", { orgId, body });
}

export async function cloudSftpMkdir(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<void> {
  await invoke("cloud_sftp_mkdir", { orgId, body });
}

export async function cloudSftpDelete(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    isDir?: boolean;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<void> {
  await invoke("cloud_sftp_delete", { orgId, body });
}

export async function cloudSftpUpload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  data: Uint8Array;
  filename?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  await invoke("cloud_sftp_upload", params);
}

export async function cloudSftpDownload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  localPath: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  await invoke("cloud_sftp_download", params);
}

export async function cloudSshTunnelExec(
  orgId: string,
  body: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    command: string;
  },
): Promise<{ stdout: string; stderr?: string; code: number }> {
  return invoke("cloud_ssh_tunnel_exec", { orgId, body });
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
  return invoke("cloud_ssh_tunnel_create_account", { orgId, body });
}
