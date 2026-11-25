/**
 * DRAFT interface for the SSH server; the ssh agent owns this file.
 *
 * The server speaks SSH over any duplex byte stream (a Worker's inbound
 * `connect()` socket in production, a Node socket in tests). It knows
 * nothing about git or Infrawrench: who a key belongs to and what a command
 * does are callbacks.
 */

export interface DuplexStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface SshPublicKey {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `rsa-sha2-512`, ... */
  readonly algorithm: string;
  /** The key blob as sent on the wire. */
  readonly blob: Uint8Array;
  /** `SHA256:...` as `ssh-keygen -lf` prints it. */
  readonly fingerprint: string;
}

export interface ExecChannel {
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: WritableStream<Uint8Array>;
  readonly stderr: WritableStream<Uint8Array>;
}

export interface SshServerOptions<Principal> {
  /** OpenSSH private host keys (PEM), ed25519 at least. */
  readonly hostKeys: readonly string[];
  /** Resolve a public key to a principal, or null to refuse it. Called before the signature is checked and again after. */
  authenticate(user: string, key: SshPublicKey): Promise<Principal | null>;
  /** Run `command` (e.g. `git-upload-pack 'owner/repo.git'`); resolve with the exit status. */
  exec(
    principal: Principal,
    command: string,
    channel: ExecChannel,
    env: ReadonlyMap<string, string>,
  ): Promise<number>;
  /** Text for a session that asks for a shell instead of a command. */
  shellGreeting?(principal: Principal): string;
}
