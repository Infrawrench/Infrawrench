import { describe, expect, it, vi } from "vitest";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";
import { getFunctionAppCreateConfig } from "../function-app-create-handlers.js";
import { getSQLDatabaseCreateConfig } from "../sql-database-create-handlers.js";
import { getContainerAppCreateConfig } from "../container-app-create-handlers.js";
import { fetchResourceGroups } from "../create-handlers-shared.js";
import type { AzureCreateContext } from "../create-handlers.js";

type Lister = (ctx: ListerContext, accountId: string) => Promise<unknown[]>;

const NEXT = "https://management.azure.com/next?$skiptoken=1";
const EVIL = "https://evil.example/subscriptions/sub1?$skiptoken=1";
const OVER = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const FOREIGN = "Refusing to send the account's credentials there";

function makeCtx(getImpl: (url: string) => unknown) {
  const get = vi.fn(async (url: string) => {
    const answer = getImpl(url);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ctx: ListerContext = {
    get: get as ListerContext["get"],
    post: vi.fn() as ListerContext["post"],
    put: vi.fn() as ListerContext["put"],
    del: vi.fn(),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    subscriptionId: "sub1",
  };
  return { ctx, get };
}

const row = (name: string) => ({
  id: `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.X/things/${name}`,
  name,
  location: "eastus",
  kind: "functionapp",
});

const LISTERS: Array<[string, Lister]> = Object.entries(listers)
  .filter(([name]) => name.startsWith("list"))
  .map(([name, fn]) => [name, fn as Lister]);

describe("every resource lister", () => {
  it("is in the table", () => {
    expect(LISTERS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(LISTERS)("%s reads the next page", async (_name, list) => {
    const { ctx, get } = makeCtx((url) =>
      url === NEXT ? { value: [] } : { value: [row("a")], nextLink: NEXT },
    );
    await list(ctx, "acct");
    expect(get).toHaveBeenCalledWith(NEXT);
  });

  it.each(LISTERS)("%s refuses a first page that is not a list", async (_name, list) => {
    const { ctx } = makeCtx(() => ({ items: [row("a")] }));
    await expect(list(ctx, "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it.each(LISTERS)("%s refuses a later page that is not a list", async (_name, list) => {
    const { ctx } = makeCtx((url) =>
      url === NEXT ? { items: [] } : { value: [row("a")], nextLink: NEXT },
    );
    await expect(list(ctx, "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it.each(LISTERS)("%s does not send the token to another host", async (_name, list) => {
    const { ctx, get } = makeCtx((url) => {
      if (url === EVIL) throw new Error("reached the foreign host");
      return { value: [row("a")], nextLink: EVIL };
    });
    await expect(list(ctx, "acct")).rejects.toThrow(FOREIGN);
    expect(get).not.toHaveBeenCalledWith(EVIL);
  });

  it.each(LISTERS)("%s stops at the page cap by refusing", async (_name, list) => {
    let n = 0;
    const { ctx } = makeCtx(() => ({
      value: [],
      nextLink: `https://management.azure.com/next?$skiptoken=${n++}`,
    }));
    await expect(list(ctx, "acct")).rejects.toThrow(OVER);
  });
});

describe("the list cap", () => {
  it("reads exactly the capped number of pages", async () => {
    let n = 0;
    const { ctx, get } = makeCtx(() => ({
      value: [],
      nextLink: `https://management.azure.com/next?$skiptoken=${n++}`,
    }));
    await expect(listers.listResourceGroups(ctx, "acct")).rejects.toThrow(OVER);
    expect(get).toHaveBeenCalledTimes(1000);
  });

  it("stops at the row ceiling a poll can write", async () => {
    let n = 0;
    const big = Array.from({ length: 5000 }, (_, i) => row(`r${i}`));
    const { ctx, get } = makeCtx(() => ({
      value: big,
      nextLink: `https://management.azure.com/next?$skiptoken=${n++}`,
    }));
    await expect(listers.listResourceGroups(ctx, "acct")).rejects.toThrow(OVER);
    expect(get).toHaveBeenCalledTimes(20);
  });

  it("does not stop on an empty page that says there is more", async () => {
    const { ctx } = makeCtx((url) => {
      if (url === NEXT) return { value: [row("late")] };
      return { value: [], nextLink: NEXT };
    });
    await expect(listers.listResourceGroups(ctx, "acct")).resolves.toHaveLength(1);
  });

  it("follows a next link written with the default port", async () => {
    const withPort = "https://management.azure.com:443/next?$skiptoken=1";
    const { ctx, get } = makeCtx((url) =>
      url === NEXT ? { value: [row("late")] } : { value: [row("a")], nextLink: withPort },
    );
    await expect(listers.listResourceGroups(ctx, "acct")).resolves.toHaveLength(2);
    expect(get).toHaveBeenLastCalledWith(NEXT);
  });
});

describe("listKeyVaults", () => {
  it("does not limit the read with $top", async () => {
    const { ctx, get } = makeCtx(() => ({ value: [] }));
    await listers.listKeyVaults(ctx, "acct");
    expect(get.mock.calls[0]![0]).not.toContain("$top");
  });
});

describe("listSQLDatabases", () => {
  const SERVER = {
    id: "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Sql/servers/srv",
    name: "srv",
  };
  const answerDatabases = (databases: () => unknown) =>
    makeCtx((url) => (url.includes("/databases?") ? databases() : { value: [SERVER] }));

  it.each([
    ["a 500", "Azure API 500: boom"],
    ["a throttle", "Azure API 429: slow down"],
    ["an expired credential", "Azure API 401: expired"],
    ["a dropped connection", "fetch failed"],
  ])("fails the type on %s for one server", async (_what, message) => {
    const { ctx } = answerDatabases(() => new Error(message));
    await expect(listers.listSQLDatabases(ctx, "acct")).rejects.toThrow(message);
  });

  it("skips a server that is gone", async () => {
    const { ctx } = answerDatabases(() => new Error("Azure API 404: ResourceNotFound"));
    await expect(listers.listSQLDatabases(ctx, "acct")).resolves.toEqual([]);
  });

  it("keeps a denied server's stored databases, and fails where nobody keeps them", async () => {
    const { ctx } = answerDatabases(() => new Error("Azure API 403: AuthorizationFailed"));
    await expect(listers.listSQLDatabases(ctx, "acct")).rejects.toThrow("403");
    const unread = vi.fn();
    Reflect.set(globalThis, Symbol.for("infrawrench.unreadListPart"), unread);
    try {
      await expect(listers.listSQLDatabases(ctx, "acct")).resolves.toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for("infrawrench.unreadListPart"));
    }
    expect(unread).toHaveBeenCalledWith({ idPrefixes: ["acct:azure-sql-database:rg/srv/"] });
  });

  it("reads a server's later pages of databases", async () => {
    const { ctx } = makeCtx((url) => {
      if (url === NEXT) return { value: [{ name: "db2" }] };
      if (url.includes("/databases?")) return { value: [{ name: "db1" }], nextLink: NEXT };
      return { value: [SERVER] };
    });
    await expect(listers.listSQLDatabases(ctx, "acct")).resolves.toHaveLength(2);
  });
});

describe("a child list read for a parent's fields", () => {
  const PARENTS: Array<[string, Lister]> = [
    ["listManagedRedis", listers.listManagedRedis],
    ["listAIServicesAccounts", listers.listAIServicesAccounts],
  ];
  const childUrl = /\/(databases|deployments)\?/;

  it.each(PARENTS)("%s still lists the parent when the child read fails", async (_name, list) => {
    const { ctx } = makeCtx((url) =>
      childUrl.test(url) ? new Error("Azure API 400: not for this kind") : { value: [row("p")] },
    );
    await expect(list(ctx, "acct")).resolves.toHaveLength(1);
  });
});

describe("create form pickers", () => {
  const createCtx = (getImpl: (url: string) => unknown) => {
    const { ctx, get } = makeCtx(getImpl);
    const create: AzureCreateContext = {
      ...ctx,
      patch: vi.fn() as AzureCreateContext["patch"],
      makeId: ctx.id,
      graphClient: {} as never,
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    };
    return { ctx: create, get };
  };

  it("lists resource groups past the first page", async () => {
    const { ctx } = createCtx((url) =>
      url === NEXT ? { value: [{ name: "b" }] } : { value: [{ name: "a" }], nextLink: NEXT },
    );
    await expect(fetchResourceGroups(ctx)).resolves.toEqual([
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ]);
  });

  it.each([
    ["function app storage accounts", getFunctionAppCreateConfig, "storageAccounts?"],
    ["SQL servers", getSQLDatabaseCreateConfig, "Microsoft.Sql/servers?"],
    ["container app environments", getContainerAppCreateConfig, "managedEnvironments?"],
    ["container registries", getContainerAppCreateConfig, "registries?"],
  ])("offers %s past the first page", async (_what, config, route) => {
    const { ctx, get } = createCtx((url) => {
      if (url === NEXT) return { value: [] };
      return url.includes(route) ? { value: [row("a")], nextLink: NEXT } : { value: [] };
    });
    await config(ctx);
    expect(get).toHaveBeenCalledWith(NEXT);
  });
});
