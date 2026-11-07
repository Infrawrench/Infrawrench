import { describe, expect, it } from "vitest";

import {
  fetchAzureCommitments,
  mapAzureReservation,
  normalizeAzureProvisioningState,
} from "../commitments.js";

describe("normalizeAzureProvisioningState", () => {
  it("folds the provisioning-state zoo to three answers", () => {
    expect(normalizeAzureProvisioningState("Succeeded")).toBe("active");
    expect(normalizeAzureProvisioningState("Creating")).toBe("queued");
    expect(normalizeAzureProvisioningState("PendingBilling")).toBe("queued");
    expect(normalizeAzureProvisioningState("Expired")).toBe("expired");
    expect(normalizeAzureProvisioningState("Cancelled")).toBe("expired");
    expect(normalizeAzureProvisioningState("BillingFailed")).toBe("expired");
    // Split/Merged records were replaced by successors: counting both
    // parent and children would double the holding.
    expect(normalizeAzureProvisioningState("Split")).toBe("expired");
    expect(normalizeAzureProvisioningState("Merged")).toBe("expired");
    expect(normalizeAzureProvisioningState("SomethingNew")).toBe("expired");
  });
});

describe("mapAzureReservation", () => {
  const reservation = {
    id: "/providers/microsoft.capacity/reservationOrders/o1/reservations/r1",
    name: "o1/r1",
    location: "westus",
    sku: { name: "Standard_D1" },
    properties: {
      displayName: "VM_RI_07-21-2020",
      provisioningState: "Succeeded",
      reservedResourceType: "VirtualMachines",
      quantity: 2,
      effectiveDateTime: "2021-04-25T00:00:00.000Z",
      benefitStartTime: "2021-04-22T22:46:32.763Z",
      expiryDateTime: "2024-04-22T22:46:32.763Z",
      term: "P3Y",
      billingPlan: "Monthly",
      appliedScopeType: "Shared",
      utilization: {
        aggregates: [
          { grain: 1, grainUnit: "days", value: 12.5, valueUnit: "percentage" },
          { grain: 7, grainUnit: "days", value: 40, valueUnit: "percentage" },
          { grain: 30, grainUnit: "days", value: 85, valueUnit: "percentage" },
        ],
        trend: "UP",
      },
    },
  };

  it("maps term, billing plan, scope and utilization — and no money", () => {
    const record = mapAzureReservation(reservation)!;
    expect(record.kind).toBe("reservation");
    // Lower-cased: the id is a join key against the BenefitId column in cost
    // data, and Azure does not agree with itself on the casing of either.
    expect(record.id).toBe("/providers/microsoft.capacity/reservationorders/o1/reservations/r1");
    // Term from the provider's own P3Y, never from the dates (Azure splits
    // and merges reservations on exchange, which moves the dates).
    expect(record.termDays).toBe(1095);
    expect(record.paymentOption).toBe("monthly");
    expect(record.scope).toBe("Shared");
    expect(record.region).toBe("westus");
    expect(record.startDate).toBe("2021-04-22T22:46:32.763Z");
    // The list response carries no purchase price: money fields absent, not 0.
    expect(record.currency).toBeUndefined();
    expect(record.upfrontAmount).toBeUndefined();
    expect(record.recurringAmount).toBeUndefined();
    // Provider utilization passed through verbatim, at all three grains.
    expect(record.providerUtilization).toEqual([
      { grainDays: 1, percentage: 12.5 },
      { grainDays: 7, percentage: 40 },
      { grainDays: 30, percentage: 85 },
    ]);
    expect(record.state).toBe("active");
  });

  it("maps Upfront billing plans to all_upfront", () => {
    const record = mapAzureReservation({
      ...reservation,
      properties: { ...reservation.properties, billingPlan: "Upfront" },
    })!;
    expect(record.paymentOption).toBe("all_upfront");
  });
});

describe("fetchAzureCommitments", () => {
  it("follows nextLink until exhausted", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown>[] = [
      {
        value: [{ id: "/r/1", properties: { provisioningState: "Succeeded" } }],
        nextLink: "https://management.azure.com/next?$skiptoken=50",
      },
      {
        value: [{ id: "/r/2", properties: { provisioningState: "Expired" } }],
        nextLink: null,
      },
      // The savings plan list, read after the reservations.
      { value: [] },
    ];
    const records = await fetchAzureCommitments({
      getJson: async <T>(url: string): Promise<T> => {
        calls.push(url);
        return pages.shift() as T;
      },
    });
    expect(records.map((r) => r.id)).toEqual(["/r/1", "/r/2"]);
    expect(calls[0]).toContain("providers/Microsoft.Capacity/reservations?api-version=2022-11-01");
    expect(calls[1]).toContain("$skiptoken=50");
  });

  describe("a failed read", () => {
    const RESERVATION = { id: "/r/1", properties: { provisioningState: "Succeeded" } };
    const PLANS = "Microsoft.BillingBenefits";

    function ctxFor(plans: (url: string) => unknown) {
      return {
        getJson: async <T>(url: string): Promise<T> => {
          const answer = url.includes(PLANS) || url.includes("/plans-next") ? plans(url) : null;
          if (answer instanceof Error) throw answer;
          return (answer ?? { value: [RESERVATION] }) as T;
        },
      };
    }

    it.each([
      ["a 500", "Azure API 500: boom"],
      ["a 503", "Azure API 503: unavailable"],
      ["a throttle", "Azure API 429: slow down"],
      ["an expired credential", "Azure API 401: expired"],
      ["a dropped connection", "fetch failed"],
    ])("does not read %s on savings plans as every plan having ended", async (_what, message) => {
      await expect(fetchAzureCommitments(ctxFor(() => new Error(message)))).rejects.toThrow(
        message,
      );
    });

    it.each([
      ["denied", "Azure API 403: AuthorizationFailed"],
      ["refused for this agreement", "Azure API 400: not supported"],
    ])("keeps the reservations when savings plans are %s", async (_what, message) => {
      const records = await fetchAzureCommitments(ctxFor(() => new Error(message)));
      expect(records.map((r) => r.id)).toEqual(["/r/1"]);
    });

    it("does not read a savings plan page that is not a list as none", async () => {
      await expect(fetchAzureCommitments(ctxFor(() => ({ plans: [] })))).rejects.toThrow(
        "is not a list",
      );
    });

    it("does not read savings plans cut at the cap as none", async () => {
      let n = 0;
      const never = () => ({
        value: [],
        nextLink: `https://management.azure.com/plans-next?$skiptoken=${n++}`,
      });
      await expect(fetchAzureCommitments(ctxFor(never))).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it("does not send the token to another host", async () => {
      const urls: string[] = [];
      const ctx = {
        getJson: async <T>(url: string): Promise<T> => {
          urls.push(url);
          return { value: [RESERVATION], nextLink: "https://evil.example/next" } as T;
        },
      };
      await expect(fetchAzureCommitments(ctx)).rejects.toThrow(
        "Refusing to send the account's credentials there",
      );
      expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
    });
  });
});
