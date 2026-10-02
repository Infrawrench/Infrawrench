import type { SshInstallContext, SshInstallResult } from "@infrawrench/plugin-base";

export const INSTALL_MESSAGES = [
  "This server is already connected to this tailnet.",
  "Tailscale is installed, but this account could not approve the device. Approve it in your tailnet to finish connecting.",
  "Tailscale is installed and connected to your tailnet.",
  "The temporary enrollment key could not be revoked. It expires automatically after five minutes.",
  "Tailscale is installed and the device is approved. It shows as connected within a few seconds.",
];

// Official installation and file-backed auth-key support:
// https://tailscale.com/docs/install/linux
// https://tailscale.com/docs/reference/tailscale-cli/up
const MARKER = "__INFRAWRENCH_TAILSCALE_STATUS__";
const UP_ERROR_MARKER = "__INFRAWRENCH_TAILSCALE_UP_ERROR__";
const statusCommand = `printf '\\n${MARKER}\\n'; tailscale status --json </dev/null || true`;

function asRoot(script: string): string {
  return `set -eu
if [ "$(uname -s)" != Linux ]; then echo 'Automatic Tailscale installation requires Linux.' >&2; exit 1; fi
if [ "$(id -u)" = 0 ]; then
  sh -s <<'INFRAWRENCH_TAILSCALE_SCRIPT'
${script}
INFRAWRENCH_TAILSCALE_SCRIPT
else
  sudo -n sh -s <<'INFRAWRENCH_TAILSCALE_SCRIPT'
${script}
INFRAWRENCH_TAILSCALE_SCRIPT
fi`;
}

export const installAndInspectScript = asRoot(`set -eu
umask 077
if ! command -v tailscale >/dev/null 2>&1; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 120 https://tailscale.com/install.sh > "$installer"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 120 -O "$installer" https://tailscale.com/install.sh
  else
    echo 'Install curl or wget before installing Tailscale.' >&2; exit 1
  fi
  # The script reaches this shell on stdin; where sh is bash, a package
  # manager reading stdin would swallow the rest of it.
  sh "$installer" </dev/null
fi
${statusCommand}`);

interface Status {
  BackendState: string;
  Self?: { ID?: string; TailscaleIPs?: string[]; DNSName?: string };
}

const NOT_RUNNING =
  "Tailscale did not report its status. Check that the tailscaled service is running on this server (it needs systemd or another init system to start it).";

export function parseStatus(output: string): Status {
  const start = output.lastIndexOf(MARKER);
  if (start < 0) throw new Error("Tailscale did not return its status.");
  let status: Status;
  try {
    status = JSON.parse(output.slice(start + MARKER.length).trim()) as Status;
  } catch {
    // `tailscale status` prints nothing on stdout when it cannot reach tailscaled.
    throw new Error(NOT_RUNNING);
  }
  if (!status || typeof status.BackendState !== "string") throw new Error(NOT_RUNNING);
  return status;
}

/** What `tailscale up` printed when it failed, if it did. */
export function parseUpError(output: string): string | undefined {
  const start = output.indexOf(UP_ERROR_MARKER);
  if (start < 0) return undefined;
  const end = output.indexOf(MARKER, start);
  const text = output.slice(start + UP_ERROR_MARKER.length, end < 0 ? undefined : end).trim();
  return text || undefined;
}

const CUSTOM_SETTINGS =
  "Tailscale on this server was previously configured with custom settings, so it will not accept new ones without them. Run `tailscale up` there with its existing flags (or `--reset` to discard them), then try again.";

export function enrollmentScript(key: string): string {
  // Constrain the only interpolated secret, even when the API returns unexpected data.
  if (!/^tskey-auth-[A-Za-z0-9-]+$/.test(key)) throw new Error("Invalid Tailscale enrollment key.");
  return asRoot(`set -eu
set +x
umask 077
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT HUP INT TERM
printf '%s' '${key}' > "$key_file"
# Do not enable Tailscale SSH, reset preferences, or take over DNS on the host.
err_file=$(mktemp)
trap 'rm -f "$key_file" "$err_file"' EXIT HUP INT TERM
tailscale up --auth-key="file:$key_file" --accept-dns=false --timeout=60s </dev/null 2>"$err_file" || {
  printf '\\n${UP_ERROR_MARKER}\\n'; tail -c 4000 "$err_file"
  ${statusCommand}
  exit 0
}
rm -f "$key_file"
${statusCommand}`);
}

export interface EnrollmentApi {
  devices(): Promise<Array<{ id: string; nodeId?: string }>>;
  createKey(): Promise<{ id: string; key: string }>;
  revokeKey(id: string): Promise<void>;
  /** Approve a device waiting for device approval. */
  approve(deviceId: string): Promise<void>;
}

/**
 * Approve the device behind `selfId` with this account. We are enrolling it on
 * the account holder's behalf, so waiting for a second, manual approval adds
 * nothing. Best effort: a token without the admin role leaves it for a human.
 */
async function approveDevice(api: EnrollmentApi, selfId: string | undefined): Promise<boolean> {
  if (!selfId) return false;
  try {
    const device = (await api.devices()).find((d) => d.nodeId === selfId || d.id === selfId);
    if (!device) return false;
    await api.approve(device.nodeId || device.id);
    return true;
  } catch {
    return false;
  }
}

/** No API token crosses SSH; one-use keys are revoked even when setup fails. */
export async function installOnSsh(
  context: SshInstallContext,
  api: EnrollmentApi,
): Promise<SshInstallResult> {
  const before = parseStatus(await context.exec(installAndInspectScript));
  if (before.Self?.ID) {
    const devices = await api.devices();
    const belongs = devices.some((d) => d.nodeId === before.Self!.ID || d.id === before.Self!.ID);
    if (!belongs)
      throw new Error(
        "This server already belongs to another tailnet. Disconnect it there before enrolling it here.",
      );
    if (before.BackendState === "Running") {
      return { message: INSTALL_MESSAGES[0]!, ...addressOf(before) };
    }
    if (before.BackendState === "NeedsMachineAuth") {
      // Joined earlier but never approved: finish the job instead of re-keying.
      const approved = await approveDevice(api, before.Self.ID);
      return {
        message: approved ? INSTALL_MESSAGES[4]! : INSTALL_MESSAGES[1]!,
        ...addressOf(before),
      };
    }
    if (before.BackendState === "Stopped") {
      throw new Error("Tailscale is stopped on this server. Start it before enrolling it again.");
    }
  }
  if (before.BackendState !== "NeedsLogin" && before.BackendState !== "NoState") {
    throw new Error(
      `Tailscale is ${before.BackendState}. Resolve its current state before enrolling this server.`,
    );
  }
  const key = await api.createKey();
  let result: SshInstallResult | undefined;
  let cleanupFailed = false;
  let failure: Error | undefined;
  try {
    const output = await context.exec(enrollmentScript(key.key));
    const after = parseStatus(output);
    if (after.BackendState !== "Running" && after.BackendState !== "NeedsMachineAuth") {
      const upError = parseUpError(output);
      if (upError && /non-default flags|--reset/.test(upError)) throw new Error(CUSTOM_SETTINGS);
      throw new Error(
        `Tailscale enrollment did not finish (${after.BackendState}).${upError ? `\n${upError}` : ""}`,
      );
    }
    if (after.BackendState === "Running") {
      const devices = await api.devices();
      if (
        !after.Self?.ID ||
        !devices.some((d) => d.nodeId === after.Self!.ID || d.id === after.Self!.ID)
      ) {
        throw new Error(
          "Could not verify that this server joined the selected tailnet. Refresh the account and check the device before retrying.",
        );
      }
    }
    // The key is pre-approved, so this only happens when the token cannot
    // approve devices; try the API once more before leaving it to a human.
    const message =
      after.BackendState === "Running"
        ? INSTALL_MESSAGES[2]!
        : (await approveDevice(api, after.Self?.ID))
          ? INSTALL_MESSAGES[4]!
          : INSTALL_MESSAGES[1]!;
    result = { message, ...addressOf(after) };
  } catch (error) {
    // Remote tools sometimes echo their arguments. Never surface a key in errors.
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(
      message.replaceAll(key.key, "[redacted]").replace(/tskey-[\w-]+/g, "[redacted]"),
    );
  } finally {
    try {
      await api.revokeKey(key.id);
    } catch {
      cleanupFailed = true;
    }
  }
  if (failure) throw new Error(failure.message + (cleanupFailed ? ` ${INSTALL_MESSAGES[3]!}` : ""));
  if (!result) throw new Error("Tailscale did not return an installation result.");
  if (cleanupFailed) result.warnings = [INSTALL_MESSAGES[3]!];
  return result;
}

function addressOf(status: Status): { address?: string } {
  const address = status.Self?.TailscaleIPs?.[0];
  return address ? { address } : {};
}
