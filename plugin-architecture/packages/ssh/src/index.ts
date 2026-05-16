export { plugin } from "./plugin.js";
export type { SshCredentials } from "./client.js";
export {
  resolveSshChain,
  forwardOutHop,
  MAX_SSH_HOPS,
  type SshHop,
  type SshAccountConfig,
  type SshAccountLoader,
  type ForwardOutCapable,
} from "./chain.js";
