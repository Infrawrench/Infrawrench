import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSshScript } from "../exec-script.js";
function fake() {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end: vi.fn() });
  const client = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    exec: vi.fn((_command, cb) => cb(undefined, channel)),
  });
  return {
    client,
    channel,
    run: (script = "secret-script", timeout?: number) =>
      execSshScript(client as unknown as Client, script, timeout),
  };
}
afterEach(() => vi.useRealTimers());
describe("provisioning script transport", () => {
  it("sends secrets on stdin, not as a shell command argument", async () => {
    const { run, client, channel } = fake();
    const result = run();
    expect(client.exec.mock.calls[0]?.[0]).toBe("sh -s");
    expect(channel.end).toHaveBeenCalledWith("secret-script");
    channel.emit("data", Buffer.from("done"));
    channel.emit("close", 0);
    await expect(result).resolves.toBe("done");
    expect(client.listenerCount("close")).toBe(0);
  });
  it.each([1, null, undefined])("rejects a non-success exit of %s", async (code) => {
    const { run, channel } = fake();
    const result = run();
    channel.emit("close", code);
    await expect(result).rejects.toThrow("failed");
  });
  it("bounds output while retaining final status", async () => {
    const { run, channel } = fake();
    const result = run();
    channel.emit("data", Buffer.from("x".repeat(2_000_000)));
    channel.emit("data", Buffer.from("final-status"));
    channel.emit("close", 0);
    const output = await result;
    expect(output.length).toBe(1_048_576);
    expect(output.endsWith("final-status")).toBe(true);
  });
  it("closes a stalled connection after the timeout", async () => {
    vi.useFakeTimers();
    const { run, client } = fake();
    const result = run("script", 100);
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(client.end).toHaveBeenCalled();
  });
  it("fails when the connection vanishes before command completion", async () => {
    const { run, client } = fake();
    const result = run();
    client.emit("close");
    await expect(result).rejects.toThrow("closed");
  });
});
