import { describe, expect, it } from "vitest";
import {
  collectOrphanGroups,
  countOrphans,
  countUnownedOrphans,
  type OrphanAccountGroup,
  type ResourceOwnerAnnotation,
  type OrphanScanAccount,
  type OrphanScanPlugin,
  type OrphanScanResource,
} from "../orphans.js";

const hetzner: OrphanScanPlugin = {
  id: "hetzner",
  displayName: "Hetzner",
  resourceTypes: [
    {
      id: "volume",
      displayName: "Volume",
      orphanRule: {
        conditions: [{ fieldKey: "serverId", when: "empty" }],
        reason: "Volume is not attached to any server",
      },
    },
    {
      id: "floating-ip",
      displayName: "Floating IP",
      orphanRule: {
        conditions: [{ fieldKey: "serverId", when: "empty" }],
        reason: "Floating IP is not assigned",
      },
    },
    // No rule: this type can never be flagged, however its fields look.
    { id: "server", displayName: "Server" },
  ],
};

const digitalocean: OrphanScanPlugin = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  resourceTypes: [
    {
      id: "volume",
      displayName: "Volume",
      orphanRule: {
        conditions: [{ fieldKey: "dropletIds", when: "empty" }],
        reason: "Volume is not attached to any Droplet",
      },
    },
  ],
};

const accounts: OrphanScanAccount[] = [
  { id: "acct-h", displayName: "Zurich", pluginId: "hetzner" },
  { id: "acct-d", displayName: "Amsterdam", pluginId: "digitalocean" },
];

function resource(over: Partial<OrphanScanResource> & { id: string }): OrphanScanResource {
  return {
    pluginId: "hetzner",
    resourceTypeId: "volume",
    accountId: "acct-h",
    displayName: over.id,
    externalId: null,
    fields: {},
    lastSyncedAt: null,
    ...over,
  };
}

describe("collectOrphanGroups", () => {
  it("returns nothing when no loaded plugin declares a rule", () => {
    expect(
      collectOrphanGroups({
        plugins: [
          {
            id: "hetzner",
            displayName: "Hetzner",
            resourceTypes: [{ id: "server", displayName: "Server" }],
          },
        ],
        accounts,
        resources: [resource({ id: "vol-1", resourceTypeId: "server" })],
      }),
    ).toEqual([]);
  });

  it("flags matching resources and carries the plugin's reason", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [
        resource({ id: "vol-1", displayName: "backups", externalId: "1001" }),
        resource({ id: "vol-2", displayName: "attached", fields: { serverId: "42" } }),
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accountName).toBe("Zurich");
    expect(groups[0]!.pluginName).toBe("Hetzner");
    expect(groups[0]!.resources).toEqual([
      {
        id: "vol-1",
        pluginId: "hetzner",
        resourceTypeId: "volume",
        resourceTypeName: "Volume",
        displayName: "backups",
        externalId: "1001",
        reason: "Volume is not attached to any server",
        cost: null,
        owner: null,
        lastSyncedAt: null,
      },
    ]);
  });

  it("never annotates cost — that is the host's job, and local mode has none", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "vol-1" })],
    });
    expect(groups[0]!.resources[0]!.cost).toBeNull();
  });

  it("never annotates ownership either — the scan knows plugins, not people", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "vol-1" })],
    });
    expect(groups[0]!.resources[0]!.owner).toBeNull();
  });

  it("ignores resource types whose plugin declares no rule for them", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "srv-1", resourceTypeId: "server" })],
    });
    expect(groups).toEqual([]);
  });

  it("ignores a plugin id that is not loaded on this host", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "vol-1", pluginId: "scaleway" })],
    });
    expect(groups).toEqual([]);
  });

  it("skips resources whose account is gone", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts: [],
      resources: [resource({ id: "vol-1" })],
    });
    expect(groups).toEqual([]);
  });

  it("groups by account, sorted by account name then type then display name", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner, digitalocean],
      accounts,
      resources: [
        resource({ id: "h-2", displayName: "beta", resourceTypeId: "volume" }),
        resource({ id: "h-1", displayName: "alpha", resourceTypeId: "floating-ip" }),
        resource({
          id: "d-1",
          displayName: "spare",
          pluginId: "digitalocean",
          resourceTypeId: "volume",
          accountId: "acct-d",
        }),
      ],
    });
    expect(groups.map((g) => g.accountName)).toEqual(["Amsterdam", "Zurich"]);
    expect(groups[1]!.resources.map((r) => r.resourceTypeName)).toEqual(["Floating IP", "Volume"]);
    expect(countOrphans(groups)).toBe(3);
  });

  it("reads a fields bag of any shape — a null or non-object bag flags only empty conditions", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [
        resource({ id: "vol-null", fields: null }),
        resource({ id: "vol-string", fields: "not-json" }),
        resource({ id: "vol-array", fields: [] }),
      ],
    });
    // All three have no readable `serverId`, which the `empty` rule matches.
    expect(groups[0]!.resources.map((r) => r.id).sort()).toEqual([
      "vol-array",
      "vol-null",
      "vol-string",
    ]);
  });

  it("does not flag a resource whose field is present but structured", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "vol-1", fields: { serverId: { id: 42 } } })],
    });
    expect(groups).toEqual([]);
  });

  it("passes lastSyncedAt through as the host stored it", () => {
    const groups = collectOrphanGroups({
      plugins: [hetzner],
      accounts,
      resources: [resource({ id: "vol-1", lastSyncedAt: "2026-07-30T12:00:00.000Z" })],
    });
    expect(groups[0]!.resources[0]!.lastSyncedAt).toBe("2026-07-30T12:00:00.000Z");
  });
});

describe("countOrphans", () => {
  it("is zero for no groups", () => {
    expect(countOrphans([])).toBe(0);
  });
});

describe("countUnownedOrphans", () => {
  const group = (...owners: (ResourceOwnerAnnotation | null)[]): OrphanAccountGroup => ({
    accountId: "acc-1",
    accountName: "Zurich",
    pluginId: "hetzner",
    pluginName: "Hetzner",
    resources: owners.map((owner, i) => ({
      id: `vol-${i}`,
      pluginId: "hetzner",
      resourceTypeId: "volume",
      resourceTypeName: "Volume",
      displayName: `vol-${i}`,
      externalId: null,
      reason: "unattached",
      cost: null,
      owner,
      lastSyncedAt: null,
    })),
  });

  const sam: ResourceOwnerAnnotation = {
    userId: "user-1",
    displayName: "Sam Reyes",
    isLabel: false,
    ticketUrl: null,
    purpose: null,
  };
  const team: ResourceOwnerAnnotation = {
    userId: null,
    displayName: "Platform team",
    isLabel: true,
    ticketUrl: null,
    purpose: null,
  };

  it("is zero for no groups", () => {
    expect(countUnownedOrphans([])).toBe(0);
  });

  it("counts only the rows with no owner annotation", () => {
    expect(countUnownedOrphans([group(sam, null, null)])).toBe(2);
  });

  it("counts a free-text owner as owned — it is still someone to ask", () => {
    // isLabel decides whether an alert can be *routed*, not whether the
    // resource is attributed. The finder's question is "who do I ask?".
    expect(countUnownedOrphans([group(team)])).toBe(0);
  });

  it("equals the total on unannotated groups — nothing is known to be owned", () => {
    const groups = [group(null, null)];
    expect(countUnownedOrphans(groups)).toBe(countOrphans(groups));
  });

  it("sums across groups", () => {
    expect(countUnownedOrphans([group(null), group(sam, null)])).toBe(2);
  });
});
