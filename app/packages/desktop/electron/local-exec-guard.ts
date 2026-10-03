/**
 * Consent gate for renderer-supplied values that hand out local code
 * execution: kubeconfigs (a `users[].user.exec` or `auth-provider` entry runs
 * an arbitrary program when kubectl, k9s or the Kubernetes client loads it)
 * and Docker hosts (control of a Docker engine is root on the machine that
 * runs it, and the default is this machine's socket).
 *
 * The renderer supplies both over IPC, so a script running in the renderer
 * could otherwise reach a shell through them. A value passes without asking
 * when it is exactly what an account in the local credential store already
 * holds (byte-equal, under the key the plugin's manifest declares), or when the
 * user approved it in a native dialog this session. Native dialogs live in the
 * main process, where renderer script cannot click them.
 *
 * Saving an account is gated too (see {@link LocalExecGuard.approveForStorage}),
 * otherwise a renderer could store the value first and then match it.
 *
 * Electron-free so it can be unit-tested; `local-exec-consent.ts` wires it to
 * the account store and `dialog`.
 */
import { createHash } from "node:crypto";

export type GuardedKind = "kubeconfig" | "dockerHost";

export interface ConsentRequest {
  kind: GuardedKind;
  /** The value as supplied (a kubeconfig, or a Docker host URL). */
  value: string;
  /** Short lines describing what would run, for the dialog body. */
  summary: string[];
  /** Why the user is being asked: before a connection, or before saving. */
  purpose: "connect" | "save";
}

export interface LocalExecGuardDeps {
  /** Values of `kind` held by stored accounts, under their manifest key. */
  storedValues(kind: GuardedKind): Promise<string[]>;
  /** Local ports of the SSH tunnels main itself has open. */
  activeTunnelPorts(): number[];
  /** Ask the user. Resolves true only on an explicit allow. */
  confirm(request: ConsentRequest): Promise<boolean>;
  now?: () => number;
}

/** A denial is remembered briefly so a burst of identical calls asks once. */
const DENIAL_TTL_MS = 60_000;

/**
 * Whether loading this kubeconfig may run a local program. Deliberately a
 * textual over-approximation rather than a parse: kubectl's YAML parser and
 * any parser here could disagree (escapes, flow mappings, JSON), and a
 * differential would be a bypass. Any backslash counts because escape
 * sequences can spell a key without its literal letters. A false positive
 * only means a confirmation dialog for a kubeconfig that is not stored.
 */
export function kubeconfigMayRunCommands(kubeconfig: string): boolean {
  return /\bexec\b|auth-?provider|authprovider|\\/i.test(kubeconfig);
}

/** Lines of a kubeconfig that name what it would run, for the dialog. */
export function summarizeKubeconfigCommands(kubeconfig: string): string[] {
  const lines = kubeconfig
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /\bexec\b|auth-?provider|authprovider|command|cmd-path|cmd-args|args|\\/i.test(l),
    )
    .slice(0, 12)
    .map((l) => (l.length > 160 ? `${l.slice(0, 160)}...` : l));
  return lines.length > 0 ? lines : ["(the kubeconfig could not be summarised)"];
}

/** The Docker driver treats an empty host as the local default socket. */
export function normalizeDockerHost(host: string | undefined): string {
  const trimmed = (host ?? "").trim();
  return trimmed === "" ? "unix:///var/run/docker.sock" : trimmed;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** `tcp://127.0.0.1:<port>`-style hosts: the port when it is loopback, else null. */
function loopbackPort(host: string): number | null {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  if (!["tcp:", "http:", "https:"].includes(url.protocol)) return null;
  if (!LOOPBACK_NAMES.has(url.hostname.toLowerCase())) return null;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function describeDockerHost(host: string): string[] {
  const normalized = normalizeDockerHost(host);
  const local =
    /^(unix|npipe):/i.test(normalized) || normalized.startsWith("/") || loopbackPort(normalized);
  return [
    `Docker host: ${normalized}`,
    local
      ? "This is the Docker engine on this computer. Controlling it is equivalent to administrator access here."
      : "Controlling a Docker engine is equivalent to administrator access on the machine that runs it.",
  ];
}

function fingerprint(kind: GuardedKind, value: string): string {
  return createHash("sha256").update(kind).update("\0").update(value).digest("hex");
}

export interface LocalExecGuard {
  /** Throws unless this kubeconfig may be handed to kubectl/k9s/the k8s client. */
  assertKubeconfig(kubeconfig: string): Promise<void>;
  /** Throws unless main may open a Docker client against this host. */
  assertDockerHost(host: string): Promise<void>;
  /**
   * Called before an account's credentials are written. Each entry is a
   * guarded value the account will hold and what it held before (undefined
   * for a new account). Throws if the user declines a new or changed value.
   */
  approveForStorage(
    entries: Array<{ kind: GuardedKind; next: string; previous: string | undefined }>,
  ): Promise<void>;
}

export function createLocalExecGuard(deps: LocalExecGuardDeps): LocalExecGuard {
  const now = deps.now ?? Date.now;
  const approved = new Set<string>();
  const denied = new Map<string, number>();
  const pending = new Map<string, Promise<boolean>>();

  async function isStored(kind: GuardedKind, value: string): Promise<boolean> {
    const stored = await deps.storedValues(kind);
    const target = kind === "dockerHost" ? normalizeDockerHost(value) : value;
    return stored.some((v) => (kind === "dockerHost" ? normalizeDockerHost(v) : v) === target);
  }

  async function ask(request: ConsentRequest): Promise<boolean> {
    const key = fingerprint(request.kind, request.value);
    if (approved.has(key)) return true;
    const deniedAt = denied.get(key);
    if (deniedAt !== undefined && now() - deniedAt < DENIAL_TTL_MS) return false;
    // Parallel calls for the same value (a plugin listing several resource
    // types at once) share one dialog.
    let inflight = pending.get(key);
    if (!inflight) {
      inflight = deps.confirm(request).finally(() => pending.delete(key));
      pending.set(key, inflight);
    }
    const ok = await inflight;
    if (ok) {
      approved.add(key);
      denied.delete(key);
    } else {
      denied.set(key, now());
    }
    return ok;
  }

  async function gate(kind: GuardedKind, value: string, summary: string[]): Promise<void> {
    const key = fingerprint(kind, value);
    if (approved.has(key)) return;
    if (await isStored(kind, value)) {
      approved.add(key);
      return;
    }
    const ok = await ask({ kind, value, summary, purpose: "connect" });
    if (!ok) {
      throw new Error(
        kind === "kubeconfig"
          ? "This kubeconfig runs a local command to authenticate, and running it was not allowed."
          : "Connecting to this Docker host was not allowed.",
      );
    }
  }

  return {
    async assertKubeconfig(kubeconfig) {
      if (!kubeconfigMayRunCommands(kubeconfig)) return;
      await gate("kubeconfig", kubeconfig, summarizeKubeconfigCommands(kubeconfig));
    },

    async assertDockerHost(host) {
      const port = loopbackPort(normalizeDockerHost(host));
      // The SSH-tunnelled form: `resolveTunneledHost` rewrites a tunnelled
      // account's host to the local end of a tunnel main itself opened.
      if (port !== null && deps.activeTunnelPorts().includes(port)) return;
      await gate("dockerHost", normalizeDockerHost(host), describeDockerHost(host));
    },

    async approveForStorage(entries) {
      for (const { kind, next, previous } of entries) {
        if (kind === "kubeconfig" && !kubeconfigMayRunCommands(next)) continue;
        const value = kind === "dockerHost" ? normalizeDockerHost(next) : next;
        const before =
          previous === undefined
            ? undefined
            : kind === "dockerHost"
              ? normalizeDockerHost(previous)
              : previous;
        if (before === value) continue;
        const summary =
          kind === "kubeconfig" ? summarizeKubeconfigCommands(next) : describeDockerHost(next);
        const ok = await ask({ kind, value, summary, purpose: "save" });
        if (!ok) {
          throw new Error(
            kind === "kubeconfig"
              ? "Saving a kubeconfig that runs a local command was not allowed."
              : "Saving this Docker host was not allowed.",
          );
        }
      }
    },
  };
}
