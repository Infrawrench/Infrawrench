/**
 * `@infrawrench/appstream-host` — staging and running `iwappd` over an SSH
 * connection the caller supplies, and driving it headlessly.
 *
 * A plain re-export surface: `server.ts` holds the staging/exec machinery,
 * `headless.ts` the screen-free driver built on top of it, and the two are
 * separate modules so the driver can depend on the server without a cycle
 * through this index.
 */

export {
  AppServerError,
  execCommand,
  type ExecChannel,
  type ExecResult,
  type SshExecutor,
} from "./exec.js";
export * from "./preflight.js";
export {
  detectArch,
  listApps,
  startAppServer,
  type AppServerSession,
  type BinarySource,
  type RemoteArch,
  type SessionOptions,
} from "./server.js";
export {
  HeadlessAppClient,
  headlessClientCaps,
  startHeadlessAppSession,
  transportFromAppServer,
  type HeadlessOptions,
  type MouseButton,
  type Screenshot,
} from "./headless.js";
export { encodePng } from "./png.js";
