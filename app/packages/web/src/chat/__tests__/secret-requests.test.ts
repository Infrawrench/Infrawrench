import { describe, expect, it } from "vitest";
import {
  pendingSecretRequestValues,
  sanitizeSecretToolBlocks,
  secretRequestMetadata,
  storedSecretToolResult,
} from "../secret-requests";

const SENTINEL = "chat-secret-sentinel-plaintext";

describe("model-blind chat secret requests", () => {
  it("drops out-of-schema plaintext before chat or pending persistence", () => {
    const [block] = sanitizeSecretToolBlocks([
      {
        type: "tool_use",
        id: "tool-1",
        name: "write_workflow_secret",
        input: {
          name: "DEPLOY_TOKEN",
          title: "Deployment token",
          description: "Token used by the deploy workflow",
          value: SENTINEL,
          ciphertext: SENTINEL,
        },
      },
    ]);
    const metadata = secretRequestMetadata(block?.type === "tool_use" ? block.input : {});
    const pendingRow = pendingSecretRequestValues({
      id: "request-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      toolUseId: "tool-1",
      metadata,
    });

    expect(JSON.stringify(block)).not.toContain(SENTINEL);
    expect(JSON.stringify(pendingRow)).not.toContain(SENTINEL);
    expect(pendingRow).toEqual({
      id: "request-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      toolUseId: "tool-1",
      secretId: null,
      name: "DEPLOY_TOKEN",
      title: "Deployment token",
      description: "Token used by the deploy workflow",
      status: "pending",
    });
  });

  it("resumes the model with metadata-only confirmation", () => {
    const result = storedSecretToolResult({
      secretId: "secret-1",
      requestId: "request-1",
      name: "DEPLOY_TOKEN",
    });

    expect(JSON.parse(result)).toEqual({
      id: "secret-1",
      name: "DEPLOY_TOKEN",
      stored: true,
    });
    expect(result).not.toContain(SENTINEL);
  });
});
