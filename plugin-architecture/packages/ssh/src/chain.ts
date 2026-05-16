/**
 * Shared SSH connection-chain primitives for "Connect through jumpbox" routing.
 *
 * Two pieces:
 *
 *   - {@link resolveSshChain} — walk an account's `connectThroughAccountId`
 *     pointer recursively to build an ordered list of hops, outermost-first.
 *     Detects cycles, enforces a depth cap. Pure logic, no I/O of its own;
 *     the caller injects an account loader.
 *
 *   - {@link forwardOutHop} — promise wrapper around ssh2's `forwardOut` for
 *     opening a tunnelled TCP stream to the next hop. The caller is responsible
 *     for creating the next ssh2.Client and calling `connect({ sock, … })` with
 *     whatever per-hop options it needs (host-key verification, agent forwarding,
 *     etc.) — keeping the chain helper unopinionated about those concerns.
 */

export interface SshHop {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface SshAccountConfig extends SshHop {
  /** Account id of the jumpbox this account routes through, if any. */
  connectThroughAccountId?: string;
}

export type SshAccountLoader = (accountId: string) => Promise<SshAccountConfig>;

/** Hard cap on chain depth — guards against misconfiguration. */
export const MAX_SSH_HOPS = 8;

/**
 * Walk the connectThrough chain starting from `rootAccountId` and return the
 * ordered list of hops, **outermost-first**: hop[0] is the jumpbox the host
 * dials directly; the last entry is the final target.
 *
 * Throws on cycles or chains deeper than {@link MAX_SSH_HOPS}.
 */
export async function resolveSshChain(
  rootAccountId: string,
  loadAccount: SshAccountLoader,
): Promise<SshHop[]> {
  const reversed: SshHop[] = [];
  const seen = new Set<string>();
  let nextId: string | undefined = rootAccountId;
  while (nextId) {
    if (seen.has(nextId)) {
      throw new Error(`SSH jumpbox chain contains a cycle at account ${nextId}`);
    }
    seen.add(nextId);
    if (reversed.length >= MAX_SSH_HOPS) {
      throw new Error(`SSH jumpbox chain exceeds the maximum of ${MAX_SSH_HOPS} hops`);
    }
    const cfg = await loadAccount(nextId);
    reversed.push({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
    });
    nextId = cfg.connectThroughAccountId?.trim() || undefined;
  }
  // [target, jump1, jump2, ...] → outermost-first
  return reversed.reverse();
}

/**
 * Minimal ssh2.Client surface we depend on — declared structurally so this
 * module does not take a direct dep on `@types/node` or `ssh2`. The returned
 * `stream` value is a Node duplex; callers (web ssh-proxy, electron ssh-shell)
 * pass it straight to ssh2's `connect({ sock })`.
 */
export interface ForwardOutCapable {
  forwardOut(
    srcAddr: string,
    srcPort: number,
    dstAddr: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: unknown) => void,
  ): void;
}

/**
 * Promise wrapper around ssh2's `forwardOut`. Opens a tunnelled TCP stream
 * from `prevClient` (an already-`ready` ssh2.Client) to `host:port` and returns
 * the underlying duplex stream. Pass this stream as the next ssh2.Client's
 * `sock` connect option.
 */
export function forwardOutHop(
  prevClient: ForwardOutCapable,
  host: string,
  port: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    prevClient.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}
