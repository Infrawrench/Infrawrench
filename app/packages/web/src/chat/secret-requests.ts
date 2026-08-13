import type { ChatContentBlock } from "@infrawrench/client-core";

export const WRITE_WORKFLOW_SECRET_TOOL_NAME = "write_workflow_secret";

export interface SecretRequestMetadata extends Record<string, unknown> {
  secretId?: string;
  name: string;
  title?: string;
  description?: string;
}

export function secretRequestMetadata(input: Record<string, unknown>): SecretRequestMetadata {
  const stringField = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const secretId = stringField("secretId");
  const title = stringField("title");
  const description = stringField("description");
  return {
    ...(secretId ? { secretId } : {}),
    name: stringField("name") ?? "workflow-secret",
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

export function sanitizeSecretToolBlocks(blocks: ChatContentBlock[]): ChatContentBlock[] {
  return blocks.map((block) =>
    block.type === "tool_use" && block.name === WRITE_WORKFLOW_SECRET_TOOL_NAME
      ? { ...block, input: secretRequestMetadata(block.input) }
      : block,
  );
}

export function pendingSecretRequestValues(args: {
  id: string;
  conversationId: string;
  messageId: string;
  toolUseId: string;
  metadata: SecretRequestMetadata;
}) {
  return {
    id: args.id,
    conversationId: args.conversationId,
    messageId: args.messageId,
    toolUseId: args.toolUseId,
    secretId: args.metadata.secretId ?? null,
    name: args.metadata.name,
    title: args.metadata.title ?? null,
    description: args.metadata.description ?? null,
    status: "pending",
  } as const;
}

export function storedSecretToolResult(request: {
  secretId: string | null;
  requestId: string;
  name: string;
}): string {
  return JSON.stringify({
    id: request.secretId ?? request.requestId,
    name: request.name,
    stored: true,
  });
}
