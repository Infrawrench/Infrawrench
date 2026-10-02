import type { Client } from "ssh2";

/** Execute a provisioning script through stdin, keeping its secrets out of process arguments. */
export function execSshScript(
  client: Client,
  script: string,
  timeoutMs = 300_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("error", onError);
      client.off("close", onClose);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("SSH connection closed during installation."));
    const timer = setTimeout(() => {
      finish(new Error("SSH installation timed out."));
      client.end();
    }, timeoutMs);
    client.once("error", onError);
    client.once("close", onClose);
    client.exec("sh -s", (error, channel) => {
      if (error) {
        finish(error);
        return;
      }
      if (settled) {
        channel.close();
        return;
      }
      let stdout = "";
      let stderr = "";
      // Keep the tail, where a provisioner's final machine-readable status lives.
      channel.on("data", (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-1_048_576);
      });
      channel.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-65_536);
      });
      channel.once("error", onError);
      channel.stderr.once("error", onError);
      channel.on("close", (code: number | null) => {
        if (code !== 0)
          finish(new Error(stderr || `SSH installation failed (exit ${code ?? "unknown"}).`));
        else finish(undefined, stdout);
      });
      channel.end(script);
    });
  });
}
