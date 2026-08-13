import {
  createWorkflowSecret,
  listWorkflowSecrets,
  updateWorkflowSecretMetadata,
  writeWorkflowSecretValue,
} from "../services/workflow-secrets";

/**
 * Thin chat adapter over the workflow-secret service. The service currently
 * exposes metadata create/list and encrypted value write separately; this
 * composes them into the id-or-name upsert the write-only chat route needs.
 */
export async function storeWorkflowSecretFromChat(args: {
  organizationId: string;
  secretId: string | null;
  name: string;
  description: string | null;
  value: string;
  onResolvedId(secretId: string): Promise<void>;
}): Promise<{ id: string; name: string }> {
  let secretId = args.secretId;
  let resolvedName = args.name;

  if (!secretId) {
    const existing = (await listWorkflowSecrets(args.organizationId)).find(
      (secret) => secret.name === args.name,
    );
    if (existing) {
      secretId = existing.id;
      resolvedName = existing.name;
    } else {
      const created = await createWorkflowSecret(args.organizationId, {
        name: args.name,
        description: args.description,
      });
      secretId = created.id;
      resolvedName = created.name;
    }
    await args.onResolvedId(secretId);
  } else {
    const updated = await updateWorkflowSecretMetadata(args.organizationId, secretId, {
      name: args.name,
      ...(args.description !== null ? { description: args.description } : {}),
    });
    resolvedName = updated.name;
  }

  await writeWorkflowSecretValue(args.organizationId, secretId, args.value);
  return { id: secretId, name: resolvedName };
}
