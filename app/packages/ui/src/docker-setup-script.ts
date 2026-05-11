/**
 * Headless orchestration for "Setup Docker on VM" — runs the same shell
 * commands on the desktop (via local SSH IPC, or cloud SSH WS proxy) and
 * the web (via the cloud SSH WS API). The caller supplies the transport
 * (`exec`), a `sudo` predicate, a progress callback, and the target host
 * for logging. Everything Docker-specific lives here so a bug fix in the
 * install/configure sequence only has to be made in one place.
 *
 * The function intentionally only returns when Docker is installed and
 * listening on TCP 127.0.0.1:2375 — wiring the result into an
 * Infrawrench account is the caller's job (the web variant POSTs to the
 * cloud SSH-tunnel API; the desktop variant writes to local SQLite).
 */

export type DockerSetupStep = "checking" | "installing" | "configuring";

export interface DockerSetupResult {
  /** `docker --version` output trimmed, if Docker was already installed or after install. */
  dockerVersion: string;
}

export interface DockerSetupContext {
  /** Run a command on the target host. */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Wrap a command with `sudo` when the connecting user isn't root. */
  sudo: (cmd: string) => string;
  /** Used for logging only; the actual host is encoded in `exec`. */
  sshHost: string;
  /** Append a line to the progress log. */
  appendLog: (msg: string) => void;
  /** Called when the script transitions to a new high-level step. */
  setStep: (step: DockerSetupStep) => void;
}

export async function runDockerSetupScript(ctx: DockerSetupContext): Promise<DockerSetupResult> {
  const { exec, sudo, sshHost, appendLog, setStep } = ctx;

  // Step 1: Check if Docker is installed
  setStep("checking");
  appendLog("Connecting to " + sshHost + "...");
  const versionResult = await exec("docker --version 2>/dev/null");

  let dockerVersion: string;
  if (versionResult.code === 0 && versionResult.stdout.includes("Docker")) {
    dockerVersion = versionResult.stdout.trim();
    appendLog("Docker found: " + dockerVersion);
  } else {
    appendLog("Docker not found. Installing...");
    setStep("installing");

    const installResult = await exec(`curl -fsSL https://get.docker.com | ${sudo("sh")} 2>&1`);
    if (installResult.code !== 0) {
      throw new Error(
        "Docker installation failed:\n" +
          (installResult.stderr || installResult.stdout).slice(0, 500),
      );
    }
    appendLog("Docker installed successfully.");

    const verifyResult = await exec("docker --version");
    if (verifyResult.code !== 0) {
      throw new Error("Docker installed but not accessible: " + verifyResult.stderr);
    }
    dockerVersion = verifyResult.stdout.trim();
    appendLog("Verified: " + dockerVersion);
  }

  // Step 2: Ensure Docker is running
  appendLog("Ensuring Docker service is running...");
  await exec(sudo("systemctl start docker 2>/dev/null || service docker start 2>/dev/null"));

  // Step 3: Check if Docker is listening on TCP
  setStep("configuring");
  appendLog("Checking Docker TCP configuration...");

  const tcpCheck = await exec("curl -s --max-time 2 http://127.0.0.1:2375/version 2>/dev/null");

  if (tcpCheck.code !== 0 || !tcpCheck.stdout.includes("ApiVersion")) {
    appendLog("Configuring Docker to listen on TCP 127.0.0.1:2375...");

    // Use printf piped to tee to avoid heredoc issues over SSH
    const confContent =
      "[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375";
    const overrideCmd = [
      sudo("mkdir -p /etc/systemd/system/docker.service.d"),
      `printf '${confContent}\\n' | ${sudo("tee /etc/systemd/system/docker.service.d/tcp.conf > /dev/null")}`,
      sudo("systemctl daemon-reload"),
      sudo("systemctl restart docker"),
    ].join(" && ");

    const configResult = await exec(overrideCmd);
    if (configResult.code !== 0) {
      throw new Error(
        "Failed to configure Docker TCP:\n" +
          (configResult.stderr || configResult.stdout).slice(0, 500),
      );
    }
    appendLog("Docker TCP listener configured on 127.0.0.1:2375.");

    await exec("sleep 2");

    const verifyTcp = await exec("curl -s --max-time 5 http://127.0.0.1:2375/version");
    if (verifyTcp.code !== 0 || !verifyTcp.stdout.includes("ApiVersion")) {
      throw new Error("Docker TCP listener not responding after configuration");
    }
    appendLog("TCP listener verified.");
  } else {
    appendLog("Docker already listening on TCP 127.0.0.1:2375.");
  }

  return { dockerVersion };
}
