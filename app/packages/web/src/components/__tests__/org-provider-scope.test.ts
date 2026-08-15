import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Guards where the org-scoped React contexts are mounted.
 *
 * The shell renders two siblings: `WebWorkspaceTabsViewport`, which draws every
 * workspace tab, and `<Outlet />`, which draws the route-rendered pages. A
 * context provided by the `/org/$orgId` layout route therefore reaches the
 * outlet and *nothing in a tab* — and almost every screen is a tab. That is how
 * "File in Jira" / "File in Linear" and the already-filed badges came to render
 * nowhere on web while the same components worked on desktop, and it is the
 * same trap three tab panels had each worked around with their own `/team/me`
 * read.
 *
 * The arrangement is a structural fact about two files, invisible to type
 * checking and to every unit test of the components involved, so it is asserted
 * on the source. Rendering the real tree would need the whole router and the
 * whole API surface; this catches the one mistake that has actually been made.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), "utf8");
}

describe("org-scoped providers are mounted above the workspace-tab viewport", () => {
  it("wraps both the viewport and the outlet in __root.tsx", () => {
    const root = read("routes/__root.tsx");

    const open = root.indexOf("<OrgProviders");
    const close = root.indexOf("</OrgProviders>");
    expect(open, "__root.tsx must mount <OrgProviders>").toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);

    const viewport = root.indexOf("<WebWorkspaceTabsViewport");
    expect(viewport, "the tab viewport must render inside <OrgProviders>").toBeGreaterThan(open);
    expect(viewport).toBeLessThan(close);

    // The authenticated shell's own outlet is the last one in the file (the
    // earlier ones are the no-org early returns: public status pages, invites,
    // /admin, sign-in redirects — none of which have an org to scope to).
    const outlet = root.lastIndexOf("<Outlet");
    expect(outlet, "the shell's outlet must render inside <OrgProviders>").toBeGreaterThan(open);
    expect(outlet).toBeLessThan(close);
  });

  it("mounts permissions and issue filing exactly once, in OrgProviders", () => {
    const providers = read("components/OrgProviders.tsx");
    expect(providers).toContain("<PermissionsProvider");
    expect(providers).toContain("<IssueFilingProvider");
    // No org (a redirect to /org/:orgId still in flight) renders bare rather
    // than providing contexts scoped to nothing.
    expect(providers).toContain("if (!orgId) return <>{children}</>;");

    // The layout route is a pass-through: a second copy of either provider
    // there would double every batched request and re-open the split the
    // hoisting closed.
    const layout = read("routes/org.$orgId.tsx");
    expect(layout).not.toContain("PermissionsProvider");
    expect(layout).not.toContain("IssueFilingProvider");
  });

  it("leaves no tab panel reading /team/me for itself", () => {
    // Every one of these was a workaround for the provider being out of reach.
    // Inside the shell the permissions context is now available everywhere,
    // including in a tab panel, so a hand-rolled read is both a duplicate
    // request and a second answer that can disagree with the first.
    const membershipRead = /\/api\/org\/[^`"']*\/team\/me/;
    const offenders = readdirSync(path.join(SRC, "components"))
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => membershipRead.test(read(path.join("components", f))));

    expect(offenders, "use usePermissions() from @/auth/permissions-context").toEqual([]);
  });
});
