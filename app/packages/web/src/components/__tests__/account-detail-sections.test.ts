import { describe, expect, it } from "vitest";
import {
  getVisibleAccountCategories,
  pickDefaultAccountSectionId,
  type CategoryState,
} from "../AccountDetailView";

function makeCategory(
  id: string,
  pluralDisplayName: string,
  resources: Array<{ id: string; displayName: string; fieldsJson?: Record<string, unknown> }> = [],
  supportsCreate = true,
): CategoryState {
  return {
    typeDef: {
      id,
      displayName: pluralDisplayName.replace(/s$/, ""),
      pluralDisplayName,
      parentTypeId: undefined,
      supportsCreate,
    },
    loading: false,
    error: null,
    resources: resources.map((resource) => ({
      id: resource.id,
      pluginId: "mock",
      resourceTypeId: id,
      displayName: resource.displayName,
      externalId: null,
      fieldsJson: resource.fieldsJson ?? {},
      outputsJson: {},
      parentResourceId: null,
    })),
  };
}

describe("account detail section selection", () => {
  it("sorts sections alphabetically and picks first with items", () => {
    const categories = [
      makeCategory("zeta", "Zeta Zones", [{ id: "z1", displayName: "Zone A" }]),
      makeCategory("alpha", "Alpha Apps", []),
      makeCategory("beta", "Beta Databases", [{ id: "b1", displayName: "Orders DB" }]),
    ];

    const visible = getVisibleAccountCategories(categories, "");
    expect(visible.map((cat) => cat.typeDef.pluralDisplayName)).toEqual([
      "Alpha Apps",
      "Beta Databases",
      "Zeta Zones",
    ]);
    expect(pickDefaultAccountSectionId(visible)).toBe("beta");
  });

  it("filters sections/resources by search query", () => {
    const categories = [
      makeCategory("beta", "Beta Databases", [
        { id: "b1", displayName: "Orders DB", fieldsJson: { region: "us-east-1" } },
      ]),
      makeCategory("zeta", "Zeta Zones", [{ id: "z1", displayName: "Zone Runner" }]),
    ];

    const visible = getVisibleAccountCategories(categories, "orders");
    expect(visible).toHaveLength(1);
    expect(visible[0]?.typeDef.id).toBe("beta");
    expect(visible[0]?.resources.map((resource) => resource.displayName)).toEqual(["Orders DB"]);
  });
});
