import { describe, expect, it, vi } from "vitest";

import {
  dispatch,
  WorkflowCapabilityError,
  type WorkflowHost,
  type WorkflowRunContext,
} from "./host.js";
import {
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_WORKFLOW_AI_MODEL,
  MAX_AI_MAX_TOKENS,
  MAX_AI_PROMPT_LENGTH,
  type WorkflowAiResult,
  type WorkflowAiSpec,
} from "./types.js";

/**
 * `infra.ai` defaults and bounds are applied in dispatch rather than in the
 * prelude, so every host — the cloud today, anything added later — sees the
 * same normalized spec. These lock that contract down.
 */

const OK: WorkflowAiResult = {
  text: "the disk is full",
  model: "claude-sonnet-5",
  stopReason: "end",
  inputTokens: 12,
  outputTokens: 6,
  costMicros: 100,
};

const ctx: WorkflowRunContext = {
  interactive: false,
  log: () => {},
  setOutput: () => {},
};

function hostWithAi(ai = vi.fn(async (_spec: WorkflowAiSpec) => OK)) {
  return { host: { ai } as unknown as WorkflowHost, ai };
}

describe("ai dispatch", () => {
  it("applies the default model and maxTokens", async () => {
    const { host, ai } = hostWithAi();
    await dispatch(host, ctx, "ai", { spec: { prompt: "why is this disk full?" } });
    expect(ai).toHaveBeenCalledWith({
      prompt: "why is this disk full?",
      model: DEFAULT_WORKFLOW_AI_MODEL,
      maxTokens: DEFAULT_AI_MAX_TOKENS,
    });
  });

  it("passes through an explicit model, system, and maxTokens", async () => {
    const { host, ai } = hostWithAi();
    await dispatch(host, ctx, "ai", {
      spec: {
        prompt: "summarize these logs",
        system: "Answer in one sentence.",
        model: "claude-haiku-4-5",
        maxTokens: 256,
      },
    });
    expect(ai).toHaveBeenCalledWith({
      prompt: "summarize these logs",
      system: "Answer in one sentence.",
      model: "claude-haiku-4-5",
      maxTokens: 256,
    });
  });

  it("clamps maxTokens to the ceiling and falls back on nonsense", async () => {
    const { host, ai } = hostWithAi();
    await dispatch(host, ctx, "ai", { spec: { prompt: "hi", maxTokens: 1_000_000 } });
    expect(ai.mock.calls[0]?.[0]).toMatchObject({ maxTokens: MAX_AI_MAX_TOKENS });
    await dispatch(host, ctx, "ai", { spec: { prompt: "hi", maxTokens: -5 } });
    expect(ai.mock.calls[1]?.[0]).toMatchObject({ maxTokens: DEFAULT_AI_MAX_TOKENS });
  });

  it("rejects a blank prompt rather than billing an empty question", async () => {
    const { host, ai } = hostWithAi();
    await expect(dispatch(host, ctx, "ai", { spec: { prompt: "   " } })).rejects.toThrow(
      /needs a prompt/,
    );
    expect(ai).not.toHaveBeenCalled();
  });

  it("rejects a model outside the allowlist, naming the options", async () => {
    const { host, ai } = hostWithAi();
    await expect(
      dispatch(host, ctx, "ai", { spec: { prompt: "hi", model: "gpt-4o" } }),
    ).rejects.toThrow(/does not support the model "gpt-4o".*claude-sonnet-5/);
    expect(ai).not.toHaveBeenCalled();
  });

  it("rejects a prompt beyond the size bound before it crosses the bridge", async () => {
    const { host, ai } = hostWithAi();
    await expect(
      dispatch(host, ctx, "ai", { spec: { prompt: "x".repeat(MAX_AI_PROMPT_LENGTH + 1) } }),
    ).rejects.toThrow(/limited to/);
    expect(ai).not.toHaveBeenCalled();
  });

  it("surfaces a capability error on a host that cannot reach a model", async () => {
    await expect(
      dispatch({} as WorkflowHost, ctx, "ai", { spec: { prompt: "hi" } }),
    ).rejects.toBeInstanceOf(WorkflowCapabilityError);
  });
});
