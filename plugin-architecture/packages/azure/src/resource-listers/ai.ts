import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  ARM,
  extractResourceGroup,
  joinRefs,
  listAllPages,
  userAssignedIdentityNames,
  type ListerContext,
} from "./shared.js";

/** Cognitive Services account-management api-version (stable). */
const COGNITIVE_API_VERSION = "2024-10-01";

type Bag = Record<string, unknown>;

/** `gpt-4o (2024-11-20, GlobalStandard x 50)`: one deployment, one line. */
function describeDeployment(deployment: Bag): string {
  const props = deployment["properties"] as Bag | undefined;
  const model = props?.["model"] as Bag | undefined;
  const sku = deployment["sku"] as Bag | undefined;
  const modelLabel = [model?.["name"], model?.["version"]].filter(Boolean).join(" ");
  const skuLabel = sku?.["name"]
    ? `${String(sku["name"])}${sku["capacity"] != null ? ` x ${String(sku["capacity"])}` : ""}`
    : "";
  const detail = [modelLabel, skuLabel].filter(Boolean).join(", ");
  return detail
    ? `${String(deployment["name"] ?? "")} (${detail})`
    : String(deployment["name"] ?? "");
}

/**
 * Azure AI services accounts at subscription scope, each with its model
 * deployments. Deployments cost one request per account; kinds without
 * deployments (Speech, Translator, ...) answer with an empty list or an error,
 * and either reads as "no deployments" rather than failing the whole listing.
 */
export async function listAIServicesAccounts(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const accounts = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=${COGNITIVE_API_VERSION}`,
  );
  return Promise.all(
    accounts.map(async (account) => {
      const name = String(account["name"] ?? "");
      const azureId = String(account["id"] ?? "");
      const rg = extractResourceGroup(azureId);
      const props = account["properties"] as Bag | undefined;
      const sku = account["sku"] as Bag | undefined;

      let deployments: Bag[] = [];
      try {
        deployments = await listAllPages(
          ctx,
          `${ARM}${azureId}/deployments?api-version=${COGNITIVE_API_VERSION}`,
        );
      } catch {
        // Not every kind hosts deployments; see the doc comment.
      }

      return {
        id: ctx.id(accountId, "azure-ai-services", `${rg}/${name}`),
        pluginId: "azure",
        resourceTypeId: "azure-ai-services",
        accountId,
        displayName: name,
        fields: {
          name,
          resourceGroup: rg,
          location: String(account["location"] ?? ""),
          kind: String(account["kind"] ?? ""),
          sku: String(sku?.["name"] ?? ""),
          provisioningState: String(props?.["provisioningState"] ?? ""),
          customSubDomainName: String(props?.["customSubDomainName"] ?? ""),
          publicNetworkAccess: String(props?.["publicNetworkAccess"] ?? "Enabled"),
          localAuthEnabled: props?.["disableLocalAuth"] !== true,
          deploymentCount: deployments.length,
          deployments: deployments.map(describeDeployment).join(", "),
          managedIdentities: joinRefs(userAssignedIdentityNames(account)),
        },
        resolvedOutputs: {
          endpoint: String(props?.["endpoint"] ?? ""),
          resourceId: azureId,
        },
        secretStates: [],
        externalId: `${rg}/${name}`,
        createdAt: String(props?.["dateCreated"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    }),
  );
}
