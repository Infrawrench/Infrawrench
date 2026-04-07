import { useState, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { sshExecCommand, sshOpenTunnel } from "../lib/ssh-tunnel";
import { formatErrorMessage } from "../lib/errors";
import { ErrorNotice } from "./ErrorNotice";

type Step = "credentials" | "checking" | "installing" | "configuring" | "done";

interface DockerSetupModalProps {
  sshHost: string;
  sourceAccountId: string;
  onClose: () => void;
  onComplete: (newAccountId: string) => void;
}

export function DockerSetupModal({ sshHost, sourceAccountId, onClose, onComplete }: DockerSetupModalProps) {
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [step, setStep] = useState<Step>("credentials");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dockerVersion, setDockerVersion] = useState<string | null>(null);

  // System key picker
  const [systemKeys, setSystemKeys] = useState<{ name: string }[] | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(false);

  async function loadSystemKeys() {
    setLoadingKeys(true);
    try {
      const keys = await invoke<{ name: string }[]>("ssh_list_system_keys");
      setSystemKeys(keys);
    } catch {
      setSystemKeys([]);
    } finally {
      setLoadingKeys(false);
    }
  }

  async function selectSystemKey(name: string) {
    const content = await invoke<string>("ssh_read_system_key", { name });
    setPrivateKey(content);
    setSystemKeys(null);
  }

  function appendLog(msg: string) {
    setLog((prev) => [...prev, msg]);
  }

  const sshConfig = useCallback(() => ({
    sshHost,
    sshPort,
    sshUser,
    privateKey: privateKey.trim(),
  }), [sshHost, sshPort, sshUser, privateKey]);

  async function exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return sshExecCommand(sshConfig(), command);
  }

  async function startSetup() {
    if (!privateKey.trim()) { setError("SSH private key is required"); return; }
    setError(null);
    setLog([]);
    setStep("checking");

    try {
      // Step 1: Check if Docker is installed
      appendLog("Connecting to " + sshHost + "...");
      const versionResult = await exec("docker --version 2>/dev/null");

      if (versionResult.code === 0 && versionResult.stdout.includes("Docker")) {
        const ver = versionResult.stdout.trim();
        setDockerVersion(ver);
        appendLog("Docker found: " + ver);
      } else {
        appendLog("Docker not found. Installing...");
        setStep("installing");

        const installResult = await exec("curl -fsSL https://get.docker.com | sh 2>&1");
        if (installResult.code !== 0) {
          throw new Error("Docker installation failed:\n" + (installResult.stderr || installResult.stdout).slice(0, 500));
        }
        appendLog("Docker installed successfully.");

        // Verify installation
        const verifyResult = await exec("docker --version");
        if (verifyResult.code !== 0) {
          throw new Error("Docker installed but not accessible: " + verifyResult.stderr);
        }
        setDockerVersion(verifyResult.stdout.trim());
        appendLog("Verified: " + verifyResult.stdout.trim());
      }

      // Step 2: Ensure Docker is running
      appendLog("Ensuring Docker service is running...");
      await exec("systemctl start docker 2>/dev/null || service docker start 2>/dev/null");

      // Step 3: Check if Docker is listening on TCP
      setStep("configuring");
      appendLog("Checking Docker TCP configuration...");

      const tcpCheck = await exec("curl -s --max-time 2 http://127.0.0.1:2375/version 2>/dev/null");

      if (tcpCheck.code !== 0 || !tcpCheck.stdout.includes("ApiVersion")) {
        appendLog("Configuring Docker to listen on TCP 127.0.0.1:2375...");

        // Create systemd override to add TCP listener (bound to localhost only for security)
        const overrideCmd = [
          "mkdir -p /etc/systemd/system/docker.service.d",
          `cat > /etc/systemd/system/docker.service.d/tcp.conf << 'EOCONF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375
EOCONF`,
          "systemctl daemon-reload",
          "systemctl restart docker",
        ].join(" && ");

        const configResult = await exec(overrideCmd);
        if (configResult.code !== 0) {
          throw new Error("Failed to configure Docker TCP:\n" + (configResult.stderr || configResult.stdout).slice(0, 500));
        }
        appendLog("Docker TCP listener configured on 127.0.0.1:2375.");

        // Wait a moment for Docker to restart
        await exec("sleep 2");

        // Verify TCP
        const verifyTcp = await exec("curl -s --max-time 5 http://127.0.0.1:2375/version");
        if (verifyTcp.code !== 0 || !verifyTcp.stdout.includes("ApiVersion")) {
          throw new Error("Docker TCP listener not responding after configuration");
        }
        appendLog("TCP listener verified.");
      } else {
        appendLog("Docker already listening on TCP 127.0.0.1:2375.");
      }

      // Step 4: Open SSH tunnel and create account
      appendLog("Opening SSH tunnel to Docker...");
      const { localPort } = await sshOpenTunnel({
        ...sshConfig(),
        remoteHost: "127.0.0.1",
        remotePort: 2375,
      });
      appendLog(`Tunnel open: localhost:${localPort} -> ${sshHost}:2375`);

      // Create the Docker account
      const db = await getDb();
      const newAccountId = crypto.randomUUID();

      const credentials = { dockerHost: "tcp://localhost:2375" };
      const { ciphertext: credCiphertext, iv: credIv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: JSON.stringify(credentials) },
      );
      const { ciphertext: keyCiphertext, iv: keyIv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: privateKey.trim() },
      );

      const displayName = `Docker on ${sshHost}`;
      await db.execute(
        "INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv) VALUES ($1, $2, $3, $4, $5)",
        [newAccountId, "docker", displayName, credCiphertext, credIv],
      );

      // Save SSH tunnel config
      const tunnelConfigId = crypto.randomUUID();
      await db.execute(
        `INSERT OR REPLACE INTO ssh_tunnel_configs
         (id, account_id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tunnelConfigId, newAccountId, sshHost, sshPort, sshUser, "127.0.0.1", 2375, keyCiphertext, keyIv],
      );

      appendLog("Docker account created.");
      setStep("done");
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  const isRunning = step === "checking" || step === "installing" || step === "configuring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-base font-semibold text-gray-100">Setup Docker on VM</h2>
          <p className="text-xs text-gray-500 mt-1">
            Host: <span className="text-gray-300 font-mono">{sshHost}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          {step === "credentials" && (
            <>
              {/* SSH credentials */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">SSH User</label>
                  <input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">SSH Port</label>
                  <input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">SSH Private Key (PEM)</label>
                  <button
                    onClick={() => void loadSystemKeys()}
                    disabled={loadingKeys}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    {loadingKeys ? "Loading..." : "Use system key"}
                  </button>
                </div>
                {systemKeys && systemKeys.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {systemKeys.map((k) => (
                      <button
                        key={k.name}
                        onClick={() => void selectSystemKey(k.name)}
                        className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:border-blue-500 hover:text-blue-300 transition-colors"
                      >
                        ~/.ssh/{k.name}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={5}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div className="bg-gray-800/50 rounded-lg p-3 space-y-1">
                <div className="text-xs text-gray-400 font-medium">This will:</div>
                <ul className="text-xs text-gray-500 space-y-0.5 list-disc pl-4">
                  <li>Check if Docker is installed on the VM</li>
                  <li>Install Docker if needed (via get.docker.com)</li>
                  <li>Configure Docker to listen on TCP (localhost only)</li>
                  <li>Create an SSH tunnel and Docker account</li>
                </ul>
              </div>
            </>
          )}

          {/* Progress log */}
          {step !== "credentials" && (
            <div className="space-y-3">
              {/* Step indicators */}
              <div className="flex items-center gap-6 text-xs">
                <StepIndicator label="Check" active={step === "checking"} done={step !== "checking"} />
                <StepIndicator label="Install" active={step === "installing"} done={step === "configuring" || step === "done"} />
                <StepIndicator label="Configure" active={step === "configuring"} done={step === "done"} />
                <StepIndicator label="Done" active={step === "done"} done={false} />
              </div>

              {/* Log output */}
              <div className="bg-gray-950 rounded-lg p-3 max-h-[200px] overflow-y-auto">
                {log.map((line, i) => (
                  <div key={i} className="text-xs font-mono text-gray-400 leading-relaxed">
                    <span className="text-gray-600 mr-2">$</span>
                    {line}
                  </div>
                ))}
                {isRunning && (
                  <div className="text-xs font-mono text-blue-400 animate-pulse mt-1">Working...</div>
                )}
              </div>

              {dockerVersion && (
                <div className="text-xs text-green-400 font-mono">{dockerVersion}</div>
              )}
            </div>
          )}

          {error && (
            <ErrorNotice
              message={error}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
              textClassName="text-xs text-red-400"
            />
          )}
        </div>

        <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isRunning}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>
          {step === "credentials" && (
            <button
              onClick={() => void startSetup()}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Start Setup
            </button>
          )}
          {step === "done" && (
            <button
              onClick={() => {
                // Find the account ID from the log — it was created during setup
                // We need to get the account ID; let's use a ref or find it from DB
                void (async () => {
                  const db = await getDb();
                  const rows = await db.select<{ id: string }[]>(
                    "SELECT a.id FROM accounts a INNER JOIN ssh_tunnel_configs s ON s.account_id = a.id WHERE s.ssh_host = $1 AND a.plugin_id = 'docker' ORDER BY a.rowid DESC LIMIT 1",
                    [sshHost],
                  );
                  if (rows[0]) onComplete(rows[0].id);
                  else onClose();
                })();
              }}
              className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors"
            >
              Open Docker Dashboard
            </button>
          )}
          {error && step !== "credentials" && (
            <button
              onClick={() => { setError(null); setStep("credentials"); }}
              className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 ${active ? "text-blue-400" : done ? "text-green-400" : "text-gray-600"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-blue-400 animate-pulse" : done ? "bg-green-400" : "bg-gray-700"}`} />
      {label}
    </div>
  );
}
