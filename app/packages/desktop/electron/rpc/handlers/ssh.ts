import { Effect, Layer } from "effect";
import { AgentSetupRpcs } from "../../../shared/rpc/groups/agent-setup";
import { SftpRpcs } from "../../../shared/rpc/groups/sftp";
import { SshKeyRpcs } from "../../../shared/rpc/groups/ssh-keys";
import { SshTunnelRpcs } from "../../../shared/rpc/groups/ssh-tunnels";
import { WorkflowSshRpcs } from "../../../shared/rpc/groups/workflow-ssh";
import { AgentSetup } from "../../agent-setup";
import { Sftp } from "../../sftp";
import { SshKeys } from "../../ssh-keys";
import { SshTunnels, WorkflowSsh } from "../../ssh-tunnel";
import { SshHostKeyHandlers, SshShellHandlers } from "./ssh-shell";

const SshTunnelHandlers = SshTunnelRpcs.toLayer(
  Effect.gen(function* () {
    const tunnels = yield* SshTunnels;
    return SshTunnelRpcs.of({
      SshTunnelOpen: (config) => tunnels.open(config),
      SshTunnelClose: ({ tunnelId }) => tunnels.close(tunnelId),
      SshTunnelsActive: () => tunnels.active,
      SshExecCommand: ({ config, command }) => tunnels.exec(config, command),
      SshExecScript: ({ config, script }) => tunnels.execScript(config, script),
    });
  }),
).pipe(Layer.provide(SshTunnels.layer));

const SshKeyHandlers = SshKeyRpcs.toLayer(
  Effect.gen(function* () {
    const keys = yield* SshKeys;
    return SshKeyRpcs.of({
      SshListSystemKeys: () => keys.listSystemKeys,
      SshReadSystemKey: ({ name }) => keys.readSystemKey(name),
      SshCheckPageant: () => keys.pageantRunning,
      SshCheck1Password: () => keys.onePasswordRunning,
      SshList1PasswordKeys: () => keys.onePasswordKeys,
    });
  }),
).pipe(Layer.provide(SshKeys.layer));

const SftpHandlers = SftpRpcs.toLayer(
  Effect.gen(function* () {
    const sftp = yield* Sftp;
    return SftpRpcs.of({
      SftpList: ({ config, path }) => sftp.list(config, path),
      SftpMkdir: ({ config, path }) => sftp.mkdir(config, path),
      SftpDelete: ({ config, path, isDir }) => sftp.remove(config, path, isDir),
      SftpUpload: ({ config, remotePath, data }) => sftp.upload(config, remotePath, data),
      SftpDownload: ({ config, remotePath, destFolder, relativePath }) =>
        sftp.download(config, remotePath, destFolder, relativePath),
    });
  }),
);

const WorkflowSshHandlers = WorkflowSshRpcs.toLayer(
  Effect.gen(function* () {
    const ssh = yield* WorkflowSsh;
    const sftp = yield* Sftp;
    return WorkflowSshRpcs.of({
      WorkflowSshExec: ({ config, command, skipHostKeyCheck }) =>
        ssh.exec(config, command, skipHostKeyCheck === true),
      WorkflowSshExecScript: ({ config, script, skipHostKeyCheck }) =>
        ssh.execScript(config, script, skipHostKeyCheck === true),
      WorkflowSshStreamStart: ({ config, command, skipHostKeyCheck }) =>
        ssh.streamStart(config, command, skipHostKeyCheck === true),
      WorkflowSshStreamRead: ({ streamId }) => ssh.streamRead(streamId),
      WorkflowSshStreamClose: ({ streamId }) => ssh.streamClose(streamId),
      WorkflowSshProbe: ({ host, port, timeoutMs }) => ssh.probe(host, port, timeoutMs),
      WorkflowSftpList: ({ config, path }) => sftp.list(config, path),
      WorkflowSftpGet: ({ config, path }) =>
        sftp.read(config, path).pipe(Effect.map((data) => ({ base64: data.toString("base64") }))),
      WorkflowSftpPut: ({ config, path, base64 }) =>
        sftp.upload(config, path, Buffer.from(base64, "base64")),
      WorkflowSftpMkdir: ({ config, path }) => sftp.mkdir(config, path),
      WorkflowSftpDelete: ({ config, path, isDir }) => sftp.remove(config, path, isDir),
    });
  }),
).pipe(Layer.provide(WorkflowSsh.layer));

const AgentSetupHandlers = AgentSetupRpcs.toLayer(
  Effect.gen(function* () {
    const setup = yield* AgentSetup;
    return AgentSetupRpcs.of({
      AgentPlanSetup: (input) => setup.plan(input),
      AgentSyncFiles: ({ repoPath, ...input }) =>
        setup.syncFiles({ ...input, ...(repoPath !== undefined ? { repoPath } : {}) }),
      AgentReconcileFetch: (input) => setup.reconcile(input),
    });
  }),
).pipe(Layer.provide(AgentSetup.layer));

/** Every SSH group's handlers (`shared/rpc/groups/ssh.ts`). */
export const SshHandlers = Layer.mergeAll(
  SshShellHandlers,
  SshHostKeyHandlers,
  SshTunnelHandlers,
  SshKeyHandlers,
  SftpHandlers,
  WorkflowSshHandlers,
  AgentSetupHandlers,
).pipe(Layer.provide(Sftp.layer));
