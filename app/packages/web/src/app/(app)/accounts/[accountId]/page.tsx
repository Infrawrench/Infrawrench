import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { loadPlugins } from "@/plugins/loader";
import { AccountDetailView } from "@/components/AccountDetailView";

interface Props {
  params: Promise<{ accountId: string }>;
}

export default async function AccountPage({ params }: Props) {
  const { accountId } = await params;
  const { organizationId } = await requireAuth();

  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
      ),
    );

  if (!account) notFound();

  const resourceRows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(
      and(
        eq(resources.accountId, accountId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    );

  const plugins = await loadPlugins();
  const plugin = plugins.find((p) => p.plugin.manifest.id === account.pluginId);
  const resourceTypes = plugin?.plugin.resourceTypes ?? [];

  return (
    <AccountDetailView
      account={account}
      resources={resourceRows}
      resourceTypes={resourceTypes.map((rt) => ({
        id: rt.id,
        displayName: rt.displayName,
        pluralDisplayName: rt.pluralDisplayName,
        parentTypeId: rt.parentTypeId,
        supportsCreate: rt.supportsCreate,
      }))}
      pluginDisplayName={plugin?.plugin.manifest.displayName ?? account.pluginId}
      pluginLogoSvg={plugin?.plugin.manifest.logoSvg ?? ""}
    />
  );
}
