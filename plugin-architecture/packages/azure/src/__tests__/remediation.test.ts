import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationResource } from "@infrawrench/plugin-base";
import { azureRemediationCommands } from "../remediation.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const commands = (r: ReturnType<typeof azureRemediationCommands>) => r.map((c) => c.command);

function resource(
  resourceTypeId: string,
  name: string,
  rg = "rg-prod-eastus",
): RemediationResource {
  return {
    resourceTypeId,
    displayName: name,
    externalId: `${rg}/${name}`,
    fields: { name, resourceGroup: rg, location: "eastus" },
  };
}

const vm: RemediationResource = {
  ...resource("azure-vm", "vm-api-01"),
  fields: {
    name: "vm-api-01",
    resourceGroup: "rg-prod-eastus",
    location: "eastus",
    vmSize: "Standard_D8s_v5",
    powerState: "VM running",
  },
};

describe("azureRemediationCommands", () => {
  it("resizes a VM in place after checking the size is available", () => {
    const out = azureRemediationCommands({
      kind: "oversized",
      resource: vm,
      sizeFieldKey: "vmSize",
      currentSize: "Standard_D8s_v5",
      targetSize: "Standard_D4s_v5",
      region: "eastus",
    });
    expect(out.every((c) => !c.destructive && c.tool === "az")).toBe(true);
    expect(out[0]!.placeholders?.[0]?.name).toBe("AZURE_SUBSCRIPTION_ID");
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "az vm list-vm-resize-options --resource-group rg-prod-eastus --name vm-api-01 --subscription "$AZURE_SUBSCRIPTION_ID" --output table",
        "az vm resize --resource-group rg-prod-eastus --name vm-api-01 --size Standard_D4s_v5 --subscription "$AZURE_SUBSCRIPTION_ID"",
      ]
    `);
  });

  it("deallocates and starts a VM for a sleep schedule", () => {
    expect(commands(azureRemediationCommands({ kind: "sleep-schedule", resource: vm })))
      .toMatchInlineSnapshot(`
      [
        "az vm deallocate --resource-group rg-prod-eastus --name vm-api-01 --subscription "$AZURE_SUBSCRIPTION_ID"",
        "az vm start --resource-group rg-prod-eastus --name vm-api-01 --subscription "$AZURE_SUBSCRIPTION_ID"",
      ]
    `);
  });

  it("covers every other lifecycle type with its own az command group", () => {
    const types = [
      "azure-app-service",
      "azure-function-app",
      "azure-container-instance",
      "azure-aks-cluster",
      "azure-app-gateway",
      "azure-mysql-flexible",
      "azure-postgres-flexible",
    ];
    const out = Object.fromEntries(
      types.map((t) => [
        t,
        commands(
          azureRemediationCommands({ kind: "sleep-schedule", resource: resource(t, "svc-1") }),
        ),
      ]),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "azure-aks-cluster": [
          "az aks stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az aks start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-app-gateway": [
          "az network application-gateway stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az network application-gateway start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-app-service": [
          "az webapp stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az webapp start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-container-instance": [
          "az container stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az container start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-function-app": [
          "az functionapp stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az functionapp start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-mysql-flexible": [
          "az mysql flexible-server stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az mysql flexible-server start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
        "azure-postgres-flexible": [
          "az postgres flexible-server stop --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
          "az postgres flexible-server start --resource-group rg-prod-eastus --name svc-1 --subscription "$AZURE_SUBSCRIPTION_ID"",
        ],
      }
    `);
  });

  it("stops and starts a container app through az rest", () => {
    expect(
      commands(
        azureRemediationCommands({
          kind: "sleep-schedule",
          resource: resource("azure-container-app", "orders-api"),
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "az rest --method post --url "https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/"rg-prod-eastus"/providers/Microsoft.App/containerApps/"orders-api"/stop?api-version=2025-07-01"",
        "az rest --method post --url "https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/"rg-prod-eastus"/providers/Microsoft.App/containerApps/"orders-api"/start?api-version=2025-07-01"",
      ]
    `);
  });

  it("deletes an empty App Service plan", () => {
    const out = azureRemediationCommands({
      kind: "orphan",
      reason: "App Service plan has no apps assigned but still bills for its reserved instances",
      resource: resource("azure-app-service-plan", "asp-legacy-p1v3"),
    });
    expect(out.map((c) => c.destructive)).toEqual([true]);
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "az appservice plan delete --resource-group rg-prod-eastus --name asp-legacy-p1v3 --subscription "$AZURE_SUBSCRIPTION_ID"",
      ]
    `);
  });

  it("quotes a resource group carrying shell metacharacters", () => {
    const out = azureRemediationCommands({
      kind: "orphan",
      reason: "",
      resource: resource("azure-app-service-plan", "plan;1", "rg's (prod)"),
    });
    expect(out[0]!.command).toMatchInlineSnapshot(
      `"az appservice plan delete --resource-group 'rg'"'"'s (prod)' --name 'plan;1' --subscription "$AZURE_SUBSCRIPTION_ID""`,
    );
  });

  it("offers scope change, renewal, refund quote and return for an idle reservation", () => {
    const out = azureRemediationCommands({
      kind: "idle-commitment",
      commitment: {
        id: "/providers/microsoft.capacity/reservationorders/7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f/reservations/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
        kind: "reservation",
        description: "vm-reservation - 4x Standard_D4s_v5 - VirtualMachines",
        scope: "Single",
        region: "eastus",
      },
    });
    expect(out.map((c) => c.destructive)).toEqual([false, false, false, false, true]);
    expect(out.slice(0, 3).every((c) => !c.placeholders)).toBe(true);
    expect(out[4]!.placeholders?.map((p) => p.name)).toEqual([
      "RETURN_QUANTITY",
      "REFUND_SESSION_ID",
    ]);
    expect(commands(out)).toMatchInlineSnapshot(`
      [
        "az reservations reservation show --reservation-order-id 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --reservation-id 9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
        "az reservations reservation update --reservation-order-id 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --reservation-id 9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d --applied-scope-type Shared",
        "az reservations reservation update --reservation-order-id 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --reservation-id 9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d --renew false",
        "az reservations reservation-order calculate-refund --reservation-order-id 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --id /providers/microsoft.capacity/reservationOrders/7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --scope Reservation --reservation-id /providers/microsoft.capacity/reservationorders/7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f/reservations/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d --quantity "$RETURN_QUANTITY"",
        "az reservations reservation-order return --reservation-order-id 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f --scope Reservation --reservation-id /providers/microsoft.capacity/reservationorders/7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f/reservations/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d --quantity "$RETURN_QUANTITY" --session-id "$REFUND_SESSION_ID" --return-reason Underutilized",
      ]
    `);
  });

  it("skips the scope change for an already-shared savings plan", () => {
    expect(
      commands(
        azureRemediationCommands({
          kind: "idle-commitment",
          commitment: {
            id: "/providers/microsoft.billingbenefits/savingsplanorders/3c2b1a09-8f7e-4d6c-b5a4-938271605f4e/savingsplans/1d2e3f40-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
            kind: "savings_plan",
            description: "Compute savings plan",
            scope: "Shared",
            region: null,
          },
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "az billing-benefits savings-plan-order savings-plan show --savings-plan-order-id 3c2b1a09-8f7e-4d6c-b5a4-938271605f4e --savings-plan-id 1d2e3f40-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
        "az billing-benefits savings-plan-order savings-plan update --savings-plan-order-id 3c2b1a09-8f7e-4d6c-b5a4-938271605f4e --savings-plan-id 1d2e3f40-5a6b-4c7d-8e9f-a0b1c2d3e4f5 --renew false",
      ]
    `);
  });

  it("returns [] for unknown types, unparseable commitment ids and missing ids", () => {
    expect(
      azureRemediationCommands({
        kind: "orphan",
        reason: "",
        resource: resource("azure-storage-account", "stacct"),
      }),
    ).toEqual([]);
    expect(
      azureRemediationCommands({
        kind: "idle-commitment",
        commitment: {
          id: "garbage",
          kind: "reservation",
          description: "",
          scope: null,
          region: null,
        },
      }),
    ).toEqual([]);
    expect(
      azureRemediationCommands({
        kind: "sleep-schedule",
        resource: { ...vm, externalId: null, fields: {} },
      }),
    ).toEqual([]);
  });
});
