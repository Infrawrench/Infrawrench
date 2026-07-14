/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshQuickConnectPanel } from "../SshQuickConnectPanel";

const invoke = vi.fn();
const dbSelect = vi.fn();
const dbExecute = vi.fn();

vi.mock("../../lib/invoke", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../../db/client", () => ({
  getDb: async () => ({ select: dbSelect, execute: dbExecute }),
}));

describe("SshQuickConnectPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    invoke.mockReset();
    dbSelect.mockReset();
    dbExecute.mockReset();
    invoke.mockImplementation(async (method: string) => {
      if (method === "ssh_list_system_keys") return [{ name: "id_ed25519" }];
      if (method === "ssh_check_pageant" || method === "ssh_check_1password") return false;
      return undefined;
    });
    dbSelect.mockResolvedValue([
      { id: "agent-key-1", name: "infrawrench-agent" },
      { id: "other-key", name: "deploy" },
    ]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("prefers the agent app key over system keys", async () => {
    await act(async () => {
      root.render(
        createElement(SshQuickConnectPanel, {
          host: "203.0.113.10",
          preferredAppKeyId: "agent-key-1",
          preferredAppKeyName: "infrawrench-agent",
          onConnect: vi.fn(),
        }),
      );
    });

    await waitFor(() => {
      const agentKey = container.querySelector<HTMLInputElement>('input[value="app:agent-key-1"]');
      const systemKey = container.querySelector<HTMLInputElement>(
        'input[value="system:id_ed25519"]',
      );
      expect(agentKey?.checked).toBe(true);
      expect(systemKey?.checked).toBe(false);
    });
  });
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
