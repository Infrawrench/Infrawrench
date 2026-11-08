/**
 * The local key pickers' sources, from the main process (`SshKeyRpcs`):
 * private keys in `~/.ssh`, and whether Pageant or 1Password's agent is
 * there to sign instead.
 */
import { Effect } from "effect";
import type { AgentSshKey } from "../../shared/rpc/groups/ssh-keys";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/** Private keys in `~/.ssh`; listing one is what lets {@link readSystemKey} read it unprompted. */
export function listSystemKeys(): Promise<{ name: string }[]> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.SshListSystemKeys()).pipe(Effect.map((keys) => [...keys])),
  );
}

/** `~/.ssh/<name>`; a name the last listing did not return asks the user first. */
export function readSystemKey(name: string): Promise<string> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.SshReadSystemKey({ name })));
}

export function isPageantAvailable(): Promise<boolean> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.SshCheckPageant()));
}

export function is1PasswordAvailable(): Promise<boolean> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.SshCheck1Password()));
}

/** The public keys 1Password's agent holds; empty when it is absent or does not answer. */
export function list1PasswordKeys(): Promise<AgentSshKey[]> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.SshList1PasswordKeys()).pipe(Effect.map((keys) => [...keys])),
  );
}
