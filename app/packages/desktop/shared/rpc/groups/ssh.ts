/**
 * Everything SSH the main process serves: interactive shells, host-key
 * prompts, tunnels and one-off commands, the key pickers' sources, SFTP, the
 * workflow sandbox's SSH, and the agent VM setup that runs over it.
 */
import { AgentSetupRpcs } from "./agent-setup";
import { SftpRpcs } from "./sftp";
import { SshHostKeyRpcs } from "./ssh-host-keys";
import { SshKeyRpcs } from "./ssh-keys";
import { SshShellRpcs } from "./ssh-shell";
import { SshTunnelRpcs } from "./ssh-tunnels";
import { WorkflowSshRpcs } from "./workflow-ssh";

export class SshRpcs extends SshShellRpcs.merge(
  SshHostKeyRpcs,
  SshTunnelRpcs,
  SshKeyRpcs,
  SftpRpcs,
  WorkflowSshRpcs,
  AgentSetupRpcs,
) {}
