import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountResourceSections } from "../../components/AccountResourceSections.js";
import type {
  SectionCategoryState,
  SectionTypeDef,
  SectionResource,
} from "../../components/AccountResourceSections.types.js";

type Cat = SectionCategoryState<SectionTypeDef, SectionResource>;

function cat(
  partial: { id: string } & Partial<Omit<Cat, "typeDef">> & { supportsCreate?: boolean },
): Cat {
  const { id, supportsCreate = false, ...rest } = partial;
  return {
    typeDef: {
      id,
      displayName: id,
      pluralDisplayName: `${id}s`,
      supportsCreate,
    },
    loading: false,
    error: null,
    resources: [],
    ...rest,
  };
}

const renderResource = (r: SectionResource) => <span key={r.id}>res:{r.displayName}</span>;

describe("AccountResourceSections", () => {
  it("renders section tabs and the default active section's resources", () => {
    const categories = [
      cat({ id: "droplet", resources: [{ id: "d1", displayName: "web-1" }] }),
      cat({ id: "volume", resources: [{ id: "v1", displayName: "vol-1" }] }),
    ];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    expect(screen.getByRole("button", { name: /droplets/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /volumes/ })).toBeInTheDocument();
    expect(screen.getByText("res:web-1")).toBeInTheDocument();
  });

  it("switches the active section when a tab is clicked", () => {
    const categories = [
      cat({ id: "droplet", resources: [{ id: "d1", displayName: "web-1" }] }),
      cat({ id: "volume", resources: [{ id: "v1", displayName: "vol-1" }] }),
    ];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    fireEvent.click(screen.getByRole("button", { name: /volumes/ }));
    expect(screen.getByText("res:vol-1")).toBeInTheDocument();
  });

  it("filters sections by the internal search query", () => {
    const categories = [
      cat({ id: "droplet", resources: [{ id: "d1", displayName: "web-1" }] }),
      cat({ id: "volume", resources: [{ id: "v1", displayName: "vol-1" }] }),
    ];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    fireEvent.change(screen.getByLabelText("Search sections or resources"), {
      target: { value: "volume" },
    });
    expect(screen.getByRole("button", { name: /volumes/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /droplets/ })).not.toBeInTheDocument();
  });

  it("shows a no-match message when search excludes everything", () => {
    const categories = [cat({ id: "droplet", resources: [{ id: "d1", displayName: "web-1" }] })];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    fireEvent.change(screen.getByLabelText("Search sections or resources"), {
      target: { value: "zzz-nope" },
    });
    expect(screen.getByText(/No sections or resources match/)).toBeInTheDocument();
  });

  it("shows the empty sync state when no resources and no create support", () => {
    const categories = [cat({ id: "droplet" })];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    expect(screen.getByText("No resources synced yet.")).toBeInTheDocument();
  });

  it("renders an error for a failed section", () => {
    const categories = [cat({ id: "droplet", error: "load failed", supportsCreate: true })];
    render(<AccountResourceSections categories={categories} renderResource={renderResource} />);
    expect(screen.getByText("load failed")).toBeInTheDocument();
  });

  it("renders the create button for create-capable types", () => {
    const categories = [cat({ id: "droplet", supportsCreate: true })];
    render(
      <AccountResourceSections
        categories={categories}
        renderResource={renderResource}
        renderCreateButton={(t) => <button key="c">create-{t.id}</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "create-droplet" })).toBeInTheDocument();
  });

  it("supports controlled search and section props", () => {
    const onSearchQueryChange = vi.fn();
    const onActiveSectionIdChange = vi.fn();
    const categories = [
      cat({ id: "droplet", resources: [{ id: "d1", displayName: "web-1" }] }),
      cat({ id: "volume", resources: [{ id: "v1", displayName: "vol-1" }] }),
    ];
    render(
      <AccountResourceSections
        categories={categories}
        renderResource={renderResource}
        searchQuery=""
        onSearchQueryChange={onSearchQueryChange}
        activeSectionId="volume"
        onActiveSectionIdChange={onActiveSectionIdChange}
      />,
    );
    // Controlled active section means volumes are shown.
    expect(screen.getByText("res:vol-1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search sections or resources"), {
      target: { value: "x" },
    });
    expect(onSearchQueryChange).toHaveBeenCalledWith("x");
    fireEvent.click(screen.getByRole("button", { name: /droplets/ }));
    expect(onActiveSectionIdChange).toHaveBeenCalledWith("droplet");
  });
});
