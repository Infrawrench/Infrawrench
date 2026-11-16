/**
 * Shared SSH tunnel core. The web service uses it with org/account extras
 * for cross-tenant lookups; the desktop main process uses it with a Pageant
 * connect override on Windows. Adapters in each consumer add their
 * domain-specific surface (lookup helpers, exec helpers).
 */
export {
  InProcessAgent,
  buildInProcessAgent,
  type InProcessAgentOptions,
  type SignOutcome,
} from "./in-process-agent.js";

export { RemoteKeyAgent, buildRemoteKeyAgent, type RemoteKeyBackend } from "./remote-key-agent.js";

export {
  SSH_SIGN_ALGORITHMS,
  isSshSignAlgorithm,
  keyTypeForAlgorithm,
  signatureAlgorithmFor,
  signSshData,
  type SshSignAlgorithm,
} from "./ssh-signing.js";

export {
  sshWireString,
  buildOpenSshPrivateKey,
  generateEd25519OpenSshKeyPair,
  sha256Fingerprint,
  computeSshPublicKeyFingerprint,
} from "./openssh-keys.js";

export {
  openTunnel,
  ensureTunnel,
  closeTunnel,
  closeAllTunnels,
  getTunnelEntries,
  findTunnel,
  SshTunnelUnavailableError,
  type TunnelRecord,
  type TunnelExtras,
  type OpenTunnelOptions,
  type TunnelPlan,
} from "./tunnels.js";

export { execSshScript } from "./exec-script.js";
