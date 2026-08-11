import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quota collection: the replacement must be atomic, and a plugin-supplied help
 * link must not reach storage unless it is safe to render as an anchor.
 *
 * The DB is a chainable fake. Every write records which handle issued it —
 * `db` directly, or the `tx` handed to `db.transaction` — which is what lets
 * the atomicity test assert the shape rather than just the outcome.
 */

vi.mock("../db/schema", () => ({
  accountQuotaUsage: {
    __t: "accountQuotaUsage",
    id: "id",
    accountId: "accountId",
    quotaKey: "quotaKey",
  },
  accountQuotaSnapshots: { __t: "accountQuotaSnapshots" },
  accountQuotaPolls: { __t: "accountQuotaPolls", accountId: "accountId", failureCount: 0 },
}));

/** Every write, tagged with the handle that issued it. */
interface Write {
  via: "db" | "tx";
  op: "insert" | "delete";
  table: string;
  values?: unknown;
}
let writes: Write[] = [];
/** Set to a table name to make that table's insert throw, simulating a mid-pass failure. */
let failInsertOn: string | null = null;
/** True once the transaction callback has been entered. */
let transactionEntered = false;
/** Rows the poll-row lookup resolves to. */
let pollRows: unknown[] = [];
/** `values(...)`/`set(...)` payloads written to accountQuotaPolls. */
let pollWrites: Record<string, unknown>[] = [];

function makeHandle(via: "db" | "tx") {
  return {
    insert: (table: { __t: string }) => {
      const self: Record<string, unknown> = {};
      self["values"] = (values: unknown) => {
        if (table.__t === "accountQuotaPolls") {
          pollWrites.push(values as Record<string, unknown>);
        } else {
          writes.push({ via, op: "insert", table: table.__t, values });
        }
        if (failInsertOn === table.__t) return Promise.reject(new Error("db exploded mid-pass"));
        return self;
      };
      self["onConflictDoUpdate"] = () => Promise.resolve(undefined);
      // Awaiting the chain directly (the snapshot insert does) has to work too.
      self["then"] = (resolve: (v: unknown) => unknown) => resolve(undefined);
      return self;
    },
    delete: (table: { __t: string }) => ({
      where: () => {
        writes.push({ via, op: "delete", table: table.__t });
        return Promise.resolve(undefined);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => {
          const chain = {
            limit: () => Promise.resolve(pollRows),
            then: (resolve: (v: unknown) => unknown) => resolve([]),
          };
          return chain;
        },
      }),
    }),
  };
}

vi.mock("../db/client", () => {
  const dbHandle = makeHandle("db") as Record<string, unknown>;
  dbHandle["transaction"] = async (fn: (tx: unknown) => Promise<unknown>) => {
    transactionEntered = true;
    // A real transaction discards its writes when the callback throws; the
    // fake propagates instead of swallowing so the caller sees the same thing.
    return fn(makeHandle("tx"));
  };
  return { db: dbHandle };
});

const fetchQuotas = vi.fn();
vi.mock("../sync-resources", () => ({
  loadAccountClient: async () => ({
    account: { pluginId: "aws" },
    plugin: { manifest: { quotas: { label: "Service Quotas" } } },
    client: { fetchQuotas },
  }),
}));

const { collectAccountQuotas, markQuotaPollFailure } = await import("../quotas/collect");

function reading(over: Record<string, unknown> = {}) {
  return {
    id: "ec2/L-1216C47A/eu-west-1",
    service: "ec2",
    name: "Running On-Demand Standard instances",
    limit: 1024,
    used: 912,
    ...over,
  };
}

beforeEach(() => {
  writes = [];
  pollWrites = [];
  pollRows = [];
  failInsertOn = null;
  transactionEntered = false;
  fetchQuotas.mockReset();
});

describe("collectAccountQuotas — atomicity", () => {
  /**
   * The three writes are one fact expressed three ways: what is true now, what
   * was true at this instant, and what is no longer true. Applied partially
   * they are not a smaller truth but a wrong one, and neither half
   * self-corrects — the next pass writes a *new* reading, so a missing
   * snapshot is a permanent hole in the trend and a surviving stale row lasts
   * until the quota reappears.
   */
  it("issues every write through the transaction, never through db directly", async () => {
    fetchQuotas.mockResolvedValue([reading(), reading({ id: "vpc/L-F678F1CE/eu-west-1" })]);

    await collectAccountQuotas("acc-1", "org-1");

    expect(transactionEntered).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((w) => w.via === "db")).toEqual([]);
    // Two upserts, two snapshots, one stale-row cleanup.
    expect(writes.filter((w) => w.table === "accountQuotaUsage" && w.op === "insert")).toHaveLength(
      2,
    );
    expect(writes.filter((w) => w.table === "accountQuotaSnapshots")).toHaveLength(2);
    expect(writes.filter((w) => w.op === "delete")).toHaveLength(1);
  });

  it("propagates a mid-pass failure so the transaction rolls back", async () => {
    fetchQuotas.mockResolvedValue([reading()]);
    failInsertOn = "accountQuotaSnapshots";

    await expect(collectAccountQuotas("acc-1", "org-1")).rejects.toThrow("db exploded mid-pass");
    // The stale-row cleanup must not have run: with the writes before it
    // discarded, deleting rows that the discarded upserts would have refreshed
    // is precisely the out-of-sync state the transaction exists to prevent.
    expect(writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  // `fetchQuotas` throws rather than returning a short list (the contract's
  // rule 3), so an empty array genuinely means "this account reports none" —
  // and every stored row is therefore stale.
  it("clears the account's rows when the provider reports no quotas", async () => {
    fetchQuotas.mockResolvedValue([]);

    const result = await collectAccountQuotas("acc-1", "org-1");

    expect(result.quotaCount).toBe(0);
    expect(writes.filter((w) => w.op === "delete")).toHaveLength(1);
    expect(writes.every((w) => w.via === "tx")).toBe(true);
  });
});

describe("collectAccountQuotas — docsUrl", () => {
  function storedDocsUrl(): unknown {
    const upsert = writes.find((w) => w.table === "accountQuotaUsage" && w.op === "insert");
    return (upsert?.values as Record<string, unknown> | undefined)?.["docsUrl"];
  }

  it("stores an https docs link", async () => {
    fetchQuotas.mockResolvedValue([
      reading({ docsUrl: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/" }),
    ]);
    await collectAccountQuotas("acc-1", "org-1");
    expect(storedDocsUrl()).toBe("https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/");
  });

  /**
   * The same boundary the failure help link crosses, reached through the other
   * field. `docsUrl` is returned unchanged by the feed and handed to
   * `window.open` on web — a worse sink than an anchor `href`, since a scheme
   * the browser executes runs without the user leaving the page.
   */
  it("refuses a docs URL the UI could not safely open", async () => {
    for (const docsUrl of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "http://example.com/docs",
      "/org/settings",
      "\njavascript:alert(1)",
    ]) {
      writes = [];
      fetchQuotas.mockResolvedValue([reading({ docsUrl })]);
      await collectAccountQuotas("acc-1", "org-1");
      expect(storedDocsUrl()).toBeNull();
    }
  });

  // Dropping the link must not drop the reading: the quota is still real and
  // still the thing the page exists to show.
  it("keeps the reading when it drops the link", async () => {
    fetchQuotas.mockResolvedValue([reading({ docsUrl: "javascript:alert(1)" })]);
    const result = await collectAccountQuotas("acc-1", "org-1");
    expect(result.quotaCount).toBe(1);
    const upsert = writes.find((w) => w.table === "accountQuotaUsage" && w.op === "insert");
    expect(upsert?.values).toMatchObject({ service: "ec2", used: 912, quotaLimit: 1024 });
  });
});

describe("markQuotaPollFailure — help links", () => {
  /** A `QuotaAccessError` as a plugin bundled with its own plugin-base throws it. */
  function quotaAccessError(helpLabel: string, helpUrl: string) {
    return Object.assign(new Error("This key cannot read Service Quotas."), {
      name: "QuotaAccessError",
      helpLabel,
      helpUrl,
    });
  }

  it("stores an https help link so the panel can explain the fix", async () => {
    await markQuotaPollFailure(
      "acc-1",
      "org-1",
      quotaAccessError("AWS quota permissions", "https://docs.aws.amazon.com/servicequotas/"),
      new Date(),
    );

    expect(pollWrites[0]).toMatchObject({
      lastErrorHelpLabel: "AWS quota permissions",
      lastErrorHelpUrl: "https://docs.aws.amazon.com/servicequotas/",
    });
  });

  /**
   * The stored URL is returned unchanged by the feed and assigned straight to
   * an anchor's `href`, so a plugin that emits a script URL would put it one
   * click away in the quota error panel.
   */
  it("refuses a help URL the UI could not safely render", async () => {
    for (const url of ["javascript:alert(1)", "http://example.com/fix", "/org/settings"]) {
      pollWrites = [];
      await markQuotaPollFailure("acc-1", "org-1", quotaAccessError("Fix", url), new Date());
      expect(pollWrites[0]).toMatchObject({
        lastErrorHelpLabel: null,
        lastErrorHelpUrl: null,
      });
      // The message still survives — a failure explained without a link is
      // strictly better than a link that should not be clicked.
      expect(pollWrites[0]?.["lastError"]).toBe("This key cannot read Service Quotas.");
    }
  });

  // Plugins bundle their own copy of `@infrawrench/plugin-base`, so the class
  // identity a plugin throws is never the one the host imported. An
  // `instanceof` check here would silently drop every real plugin's help link.
  it("matches QuotaAccessError structurally, since plugins bundle their own copy", async () => {
    await markQuotaPollFailure(
      "acc-1",
      "org-1",
      quotaAccessError("Docs", "https://example.com/setup"),
      new Date(),
    );
    expect(pollWrites[0]?.["lastErrorHelpUrl"]).toBe("https://example.com/setup");
  });

  it("ignores a help link hung on an ordinary error", async () => {
    const e = Object.assign(new Error("boom"), {
      helpLabel: "Fix",
      helpUrl: "https://example.com",
    });
    await markQuotaPollFailure("acc-1", "org-1", e, new Date());
    expect(pollWrites[0]).toMatchObject({ lastErrorHelpLabel: null, lastErrorHelpUrl: null });
  });
});
