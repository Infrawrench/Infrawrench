// Server-side resolution of a resource's RDP address. The web RDP proxy MUST
// resolve the destination here — from the authenticated resource — and never
// trust the host the browser puts in its RDCleanPath request, or a client could
// point the server at any internal host:port (SSRF).
import { getClientForAccount } from "@/services/plugin-clients";

export interface ResolvedRdpTarget {
  host: string;
  port: number;
}

/**
 * Resolve the RDP host for a resource, applying the same `rdpEndpoint` gates
 * (running + Windows) the detail route uses. Returns null when the type has no
 * RDP endpoint, the machine isn't a running Windows VM, or no address resolves.
 */
export async function resolveRdpTarget(
  organizationId: string,
  accountId: string,
  resourceId: string,
): Promise<ResolvedRdpTarget | null> {
  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return null;
  const { client, plugin } = ctx;

  const resourceTypeId = resourceId.split(":")[1];
  if (!resourceTypeId) return null;
  const rt = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  const rdp = rt?.rdpEndpoint;
  if (!rdp) return null;

  let resources;
  try {
    resources = await client.listResources(resourceTypeId, accountId);
  } catch {
    return null;
  }
  const instance = resources.find((r) => r.id === resourceId);
  if (!instance) return null;

  const fields = instance.fields ?? {};
  const outputs = instance.resolvedOutputs ?? {};
  const gatePasses = (guard?: { fieldKey: string; value: string }): boolean => {
    if (!guard) return true;
    return String(fields[guard.fieldKey] ?? "").toLowerCase() === guard.value.toLowerCase();
  };
  if (!gatePasses(rdp.runningWhen) || !gatePasses(rdp.windowsWhen)) return null;

  const host = String(outputs[rdp.hostOutputKey] ?? fields[rdp.hostOutputKey] ?? "");
  if (!host) return null;
  return { host, port: 3389 };
}
