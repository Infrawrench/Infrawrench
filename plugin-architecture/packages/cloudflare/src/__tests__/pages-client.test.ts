import { describe, it, expect, vi } from "vitest";
import {
  listPagesProjects,
  createPagesProject,
  deletePagesProject,
  listAllPagesDeployments,
  deletePagesDeployment,
} from "../clients/pages-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const PROJECT = {
  name: "my-app",
  subdomain: "my-app.pages.dev",
  production_branch: "main",
  domains: ["www.a.com", "a.com"],
  latest_deployment: { latest_stage: "deploy", url: "https://x.pages.dev" },
  build_config: { framework: "astro" },
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

const DEPLOYMENT = {
  id: "dep1",
  environment: "production",
  url: "https://dep1.pages.dev",
  source: { branch: "main", commit_hash: "abc", commit_message: "init" },
  latest_stage: { status: "success" },
  deployment_trigger: "push",
  created_on: "2020-01-01T00:00:00Z",
};

function pagesApi(over: Record<string, unknown> = {}) {
  const projects = {
    list: vi.fn(() => asyncIter([PROJECT])),
    create: vi.fn(async () => PROJECT),
    delete: vi.fn(async () => undefined),
    deployments: {
      list: vi.fn(() => asyncIter([DEPLOYMENT])),
      delete: vi.fn(async () => undefined),
    },
  };
  return makeApi({ cf: { pages: { projects } }, ...over });
}

describe("pages-client", () => {
  it("listPagesProjects maps a project", async () => {
    const api = pagesApi();
    const out = await listPagesProjects(api, "acct");
    expect(out[0].id).toBe("acct:pages-project:my-app");
    expect(out[0].externalId).toBe("my-app");
    expect(out[0].fields.subdomain).toBe("my-app.pages.dev");
    expect(out[0].fields.framework).toBe("astro");
    expect(out[0].fields.domains).toBe("www.a.com, a.com");
    expect(out[0].resolvedOutputs?.projectName).toBe("my-app");
  });

  it("listPagesProjects falls back for missing fields", async () => {
    const api = pagesApi({ cf: { pages: { projects: { list: vi.fn(() => asyncIter([{}])) } } } });
    const out = await listPagesProjects(api, "acct");
    expect(out[0].fields.subdomain).toBe(".pages.dev");
    expect(out[0].fields.domains).toBe("");
  });

  it("createPagesProject sends name + production_branch", async () => {
    const api = pagesApi();
    await createPagesProject(api, "acct", { name: "my-app", productionBranch: "prod" });
    expect(api.cf.pages.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-app", production_branch: "prod", account_id: "acct-cf" }),
    );
  });

  it("createPagesProject defaults production_branch to main", async () => {
    const api = pagesApi();
    await createPagesProject(api, "acct", { name: "my-app" });
    expect(api.cf.pages.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ production_branch: "main" }),
    );
  });

  it("deletePagesProject calls delete with account id", async () => {
    const api = pagesApi();
    await deletePagesProject(api, "my-app");
    expect(api.cf.pages.projects.delete).toHaveBeenCalledWith("my-app", { account_id: "acct-cf" });
  });

  it("listAllPagesDeployments maps deployments with parent project", async () => {
    const api = pagesApi();
    const out = await listAllPagesDeployments(api, "acct");
    expect(out[0].id).toBe("acct:pages-deployment:my-app/dep1");
    expect(out[0].externalId).toBe("my-app/dep1");
    expect(out[0].parentResourceId).toBe("acct:pages-project:my-app");
    expect(out[0].fields.status).toBe("success");
    expect(out[0].fields.commitHash).toBe("abc");
  });

  it("listAllPagesDeployments caps at 5 deployments per project", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...DEPLOYMENT, id: `d${i}` }));
    const api = pagesApi({
      cf: {
        pages: {
          projects: {
            list: vi.fn(() => asyncIter([PROJECT])),
            deployments: { list: vi.fn(() => asyncIter(many)) },
          },
        },
      },
    });
    const out = await listAllPagesDeployments(api, "acct");
    expect(out).toHaveLength(5);
  });

  it("listAllPagesDeployments skips projects whose deployments throw", async () => {
    const api = pagesApi({
      cf: {
        pages: {
          projects: {
            list: vi.fn(() => asyncIter([PROJECT])),
            deployments: {
              list: vi.fn(() => {
                throw new Error("nope");
              }),
            },
          },
        },
      },
    });
    const out = await listAllPagesDeployments(api, "acct");
    expect(out).toEqual([]);
  });

  it("deletePagesDeployment parses the composite id", async () => {
    const api = pagesApi();
    await deletePagesDeployment(api, "my-app/dep1");
    expect(api.cf.pages.projects.deployments.delete).toHaveBeenCalledWith("my-app", "dep1", {
      account_id: "acct-cf",
    });
  });

  it("deletePagesDeployment throws on a malformed id", async () => {
    await expect(deletePagesDeployment(pagesApi(), "bad")).rejects.toThrow(
      "Invalid pages deployment ID",
    );
  });
});
