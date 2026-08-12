import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRINCIPAL_CREATED_KEY as PB_CREATED_KEY,
  DEFAULT_PRINCIPAL_LAST_USED_KEY as PB_LAST_USED_KEY,
} from "@infrawrench/plugin-base";
import {
  ACCESS_REVIEW_RULE_IDS,
  DEFAULT_ACCESS_REVIEW_STALE_DAYS,
  DEFAULT_PRINCIPAL_CREATED_KEY,
  DEFAULT_PRINCIPAL_LAST_USED_KEY,
  accessFindingKey,
  accessReviewToCsv,
  alertableAccessFindings,
  collectAccessPrincipals,
  computeAccessReview,
  normalizeStaleDays,
  type AccessScanInput,
  type AccessScanOptions,
} from "../access-review";
import type { ExpiryListResponse } from "../expiry";
import type { ResourceOwnerAnnotation } from "../ownership";

const NOW = Date.parse("2026-08-11T00:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function scan(
  fields: Record<string, unknown>,
  declaration: Record<string, unknown> = { role: "key" },
  overrides: Partial<AccessScanInput> = {},
): AccessScanInput {
  return {
    plugins: [
      {
        id: "acme",
        displayName: "Acme",
        resourceTypes: [
          {
            id: "acme-key",
            displayName: "API Key",
            principalRole: declaration as never,
          },
        ],
      },
    ],
    accounts: [{ id: "acct-1", displayName: "Production", pluginId: "acme" }],
    resources: [
      {
        id: "res-1",
        pluginId: "acme",
        resourceTypeId: "acme-key",
        accountId: "acct-1",
        displayName: "deploy-key",
        externalId: "key_123",
        fields,
      },
    ],
    ...overrides,
  };
}

function run(input: AccessScanInput, options: AccessScanOptions = {}) {
  return computeAccessReview(input, { now: NOW, includeUnowned: false, ...options });
}

function ruleIds(input: AccessScanInput, options: AccessScanOptions = {}): string[] {
  return run(input, options).findings.map((f) => f.ruleId);
}

describe("key defaults", () => {
  // client-core restates the defaults because its plugin-base import must stay
  // type-only; if the two ever disagree a bare `{ role: "key" }` reads a
  // different field on the host than the registry test validated.
  it("match plugin-base's exported constants", () => {
    expect(DEFAULT_PRINCIPAL_LAST_USED_KEY).toBe(PB_LAST_USED_KEY);
    expect(DEFAULT_PRINCIPAL_CREATED_KEY).toBe(PB_CREATED_KEY);
  });
});

describe("collectAccessPrincipals", () => {
  it("only collects types that declare principalRole", () => {
    const input = scan({});
    input.plugins = [
      {
        id: "acme",
        displayName: "Acme",
        resourceTypes: [{ id: "acme-key", displayName: "API Key" }],
      },
    ];
    expect(collectAccessPrincipals(input, { now: NOW })).toEqual([]);
  });

  it("skips resources whose account is gone", () => {
    const input = scan({ lastUsedAt: daysAgo(1) });
    input.accounts = [];
    expect(collectAccessPrincipals(input, { now: NOW })).toEqual([]);
  });

  it("reads the defaulted keys when the declaration names none", () => {
    const [p] = collectAccessPrincipals(scan({ lastUsedAt: daysAgo(3), createdAt: daysAgo(400) }), {
      now: NOW,
    });
    expect(p?.daysSinceLastUsed).toBe(3);
    expect(p?.ageDays).toBe(400);
    expect(p?.activity).toBe("active");
  });

  it("reads explicitly declared keys", () => {
    const [p] = collectAccessPrincipals(
      scan(
        { passwordLastUsed: daysAgo(200), createDate: daysAgo(900) },
        { role: "user", lastUsedKey: "passwordLastUsed", createdKey: "createDate" },
      ),
      { now: NOW },
    );
    expect(p?.daysSinceLastUsed).toBe(200);
    expect(p?.ageDays).toBe(900);
    expect(p?.role).toBe("user");
  });

  it("carries the declared revoke action onto the row", () => {
    const [p] = collectAccessPrincipals(
      scan({}, { role: "binding", revokeActionId: "deactivate" }),
      { now: NOW },
    );
    expect(p?.revokeActionId).toBe("deactivate");
  });

  it("tolerates a non-object fields bag", () => {
    const input = scan({});
    input.resources = [{ ...input.resources[0]!, fields: "not-an-object" }];
    const [p] = collectAccessPrincipals(input, { now: NOW });
    expect(p?.activity).toBe("unknown");
    expect(p?.admin).toBeNull();
  });
});

describe("activity — unknown never becomes stale", () => {
  it("is unknown when the type declares no last-used field the lister fills", () => {
    const [p] = collectAccessPrincipals(scan({ createdAt: daysAgo(1000) }), { now: NOW });
    expect(p?.lastUsedAt).toBeNull();
    expect(p?.daysSinceLastUsed).toBeNull();
    expect(p?.activity).toBe("unknown");
  });

  it("is unknown for an empty stored value", () => {
    const [p] = collectAccessPrincipals(scan({ lastUsedAt: "" }), { now: NOW });
    expect(p?.activity).toBe("unknown");
  });

  it("is unknown for an unparseable stored value", () => {
    const [p] = collectAccessPrincipals(scan({ lastUsedAt: "never" }), { now: NOW });
    expect(p?.activity).toBe("unknown");
  });

  it("is unknown for a small number that is a count, not a date", () => {
    const [p] = collectAccessPrincipals(scan({ lastUsedAt: 5432 }), { now: NOW });
    expect(p?.activity).toBe("unknown");
  });

  it("raises no stale finding for any of those", () => {
    for (const value of [undefined, "", "never", 5432, null]) {
      const fields = value === undefined ? {} : { lastUsedAt: value };
      expect(ruleIds(scan(fields))).not.toContain(ACCESS_REVIEW_RULE_IDS.stale);
    }
  });

  it("counts unknown-activity principals so the surface can say so", () => {
    expect(run(scan({})).unknownActivityCount).toBe(1);
    expect(run(scan({ lastUsedAt: daysAgo(1) })).unknownActivityCount).toBe(0);
  });

  it("accepts epoch seconds and epoch milliseconds alike", () => {
    const seconds = Math.floor((NOW - 10 * DAY) / 1000);
    expect(
      collectAccessPrincipals(scan({ lastUsedAt: seconds }), { now: NOW })[0]?.daysSinceLastUsed,
    ).toBe(10);
    expect(
      collectAccessPrincipals(scan({ lastUsedAt: NOW - 10 * DAY }), { now: NOW })[0]
        ?.daysSinceLastUsed,
    ).toBe(10);
  });
});

describe("stale-principal rule", () => {
  it("fires past the window and not inside it", () => {
    expect(ruleIds(scan({ lastUsedAt: daysAgo(91) }))).toContain(ACCESS_REVIEW_RULE_IDS.stale);
    expect(ruleIds(scan({ lastUsedAt: daysAgo(89) }))).not.toContain(ACCESS_REVIEW_RULE_IDS.stale);
  });

  it("uses the configured window", () => {
    const fields = { lastUsedAt: daysAgo(45) };
    expect(ruleIds(scan(fields), { staleDays: 30 })).toContain(ACCESS_REVIEW_RULE_IDS.stale);
    expect(ruleIds(scan(fields), { staleDays: 180 })).not.toContain(ACCESS_REVIEW_RULE_IDS.stale);
  });

  it("escalates when the stale principal is also an admin", () => {
    const plain = run(scan({ lastUsedAt: daysAgo(200) })).findings.find(
      (f) => f.ruleId === ACCESS_REVIEW_RULE_IDS.stale,
    );
    expect(plain?.severity).toBe("medium");
    const admin = run(
      scan(
        { lastUsedAt: daysAgo(200), role: "admin" },
        {
          role: "role",
          adminIndicatorKey: "role",
          adminValues: ["admin"],
        },
      ),
    ).findings.find((f) => f.ruleId === ACCESS_REVIEW_RULE_IDS.stale);
    expect(admin?.severity).toBe("high");
  });
});

describe("admin-principal rule", () => {
  const declaration = { role: "role", adminIndicatorKey: "permissions", adminValues: ["*"] };

  it("fires on an exact, case-insensitive value match", () => {
    expect(ruleIds(scan({ permissions: "*" }, declaration))).toContain(
      ACCESS_REVIEW_RULE_IDS.admin,
    );
  });

  // The `sourceRanges equals "0.0.0.0/0"` stance: matching a fragment of a
  // comma-joined list would call a read-only role administrative.
  it("does not fire on a value that merely contains the admin value", () => {
    expect(ruleIds(scan({ permissions: "widgets:read, *" }, declaration))).not.toContain(
      ACCESS_REVIEW_RULE_IDS.admin,
    );
  });

  it("reads the indicator as a boolean when no adminValues are declared", () => {
    const boolDecl = { role: "user", adminIndicatorKey: "isAdmin" };
    expect(ruleIds(scan({ isAdmin: true }, boolDecl))).toContain(ACCESS_REVIEW_RULE_IDS.admin);
    expect(ruleIds(scan({ isAdmin: "yes" }, boolDecl))).toContain(ACCESS_REVIEW_RULE_IDS.admin);
    expect(ruleIds(scan({ isAdmin: false }, boolDecl))).not.toContain(ACCESS_REVIEW_RULE_IDS.admin);
    // An unrecognised word must not be read as either answer.
    expect(
      collectAccessPrincipals(scan({ isAdmin: "maybe" }, boolDecl), { now: NOW })[0]?.admin,
    ).toBeNull();
  });

  it("never fires where the type declares no indicator", () => {
    expect(collectAccessPrincipals(scan({ role: "admin" }), { now: NOW })[0]?.admin).toBeNull();
    expect(ruleIds(scan({ role: "admin" }))).not.toContain(ACCESS_REVIEW_RULE_IDS.admin);
  });
});

describe("key-past-rotation rule", () => {
  function expiryFeed(basis: "age" | "expiry", daysRemaining: number): ExpiryListResponse {
    return {
      items: [
        {
          resourceId: "res-1",
          pluginId: "acme",
          pluginName: "Acme",
          resourceTypeId: "acme-key",
          resourceTypeName: "API Key",
          accountId: "acct-1",
          accountName: "Production",
          displayName: "deploy-key",
          externalId: "key_123",
          fieldKey: "createdAt",
          kind: "api-token",
          label: "Key age",
          basis,
          dueAt: new Date(NOW + daysRemaining * DAY).toISOString(),
          daysRemaining,
          severity: daysRemaining < 0 ? "expired" : "ok",
        },
      ],
      totalCount: 1,
      counts: { expired: 0, critical: 0, warning: 0, upcoming: 0, ok: 0 },
      leadDays: 60,
      generatedAt: new Date(NOW).toISOString(),
    };
  }

  it("reuses the radar's age rules rather than recomputing a budget", () => {
    expect(ruleIds(scan({}), { expiry: expiryFeed("age", -30) })).toContain(
      ACCESS_REVIEW_RULE_IDS.rotation,
    );
  });

  it("ignores absolute-expiry items — the radar already alerts on those", () => {
    expect(ruleIds(scan({}), { expiry: expiryFeed("expiry", -30) })).not.toContain(
      ACCESS_REVIEW_RULE_IDS.rotation,
    );
  });

  it("ignores budgets that have not run out", () => {
    expect(ruleIds(scan({}), { expiry: expiryFeed("age", 12) })).not.toContain(
      ACCESS_REVIEW_RULE_IDS.rotation,
    );
  });

  it("raises nothing without an expiry feed", () => {
    expect(ruleIds(scan({}))).not.toContain(ACCESS_REVIEW_RULE_IDS.rotation);
  });

  it("escalates a very overdue budget", () => {
    const mild = run(scan({}), { expiry: expiryFeed("age", -30) }).findings.find(
      (f) => f.ruleId === ACCESS_REVIEW_RULE_IDS.rotation,
    );
    expect(mild?.severity).toBe("medium");
    const bad = run(scan({}), { expiry: expiryFeed("age", -400) }).findings.find(
      (f) => f.ruleId === ACCESS_REVIEW_RULE_IDS.rotation,
    );
    expect(bad?.severity).toBe("high");
  });
});

describe("no-recorded-owner rule", () => {
  const owner: ResourceOwnerAnnotation = {
    userId: "u-1",
    displayName: "Ada",
    isLabel: false,
    ticketUrl: null,
    purpose: null,
  };

  it("fires when nothing names an owner", () => {
    const review = computeAccessReview(scan({}), { now: NOW });
    expect(review.findings.map((f) => f.ruleId)).toContain(ACCESS_REVIEW_RULE_IDS.unowned);
  });

  it("does not fire when the ownership join names somebody", () => {
    const input = scan({});
    input.owners = new Map([["res-1", owner]]);
    const review = computeAccessReview(input, { now: NOW });
    expect(review.findings.map((f) => f.ruleId)).not.toContain(ACCESS_REVIEW_RULE_IDS.unowned);
    expect(review.principals[0]?.owner?.displayName).toBe("Ada");
  });

  // A host with no ownership store would otherwise flag every principal, which
  // is a claim about the host rather than about the cloud.
  it("is suppressed entirely when the host has no ownership concept", () => {
    const review = computeAccessReview(scan({}), { now: NOW, includeUnowned: false });
    expect(review.findings.map((f) => f.ruleId)).not.toContain(ACCESS_REVIEW_RULE_IDS.unowned);
  });
});

describe("no-mfa rule", () => {
  const declaration = { role: "user", mfaKey: "mfaEnabled" };

  it("fires only on an explicit false", () => {
    expect(ruleIds(scan({ mfaEnabled: false }, declaration))).toContain(
      ACCESS_REVIEW_RULE_IDS.noMfa,
    );
    expect(ruleIds(scan({ mfaEnabled: true }, declaration))).not.toContain(
      ACCESS_REVIEW_RULE_IDS.noMfa,
    );
  });

  it("never fires when the field is missing or unreadable", () => {
    expect(ruleIds(scan({}, declaration))).not.toContain(ACCESS_REVIEW_RULE_IDS.noMfa);
    expect(ruleIds(scan({ mfaEnabled: "sometimes" }, declaration))).not.toContain(
      ACCESS_REVIEW_RULE_IDS.noMfa,
    );
  });

  it("never fires where the type declares no mfaKey", () => {
    expect(collectAccessPrincipals(scan({ mfaEnabled: false }), { now: NOW })[0]?.mfa).toBeNull();
    expect(ruleIds(scan({ mfaEnabled: false }))).not.toContain(ACCESS_REVIEW_RULE_IDS.noMfa);
  });

  it("is critical on an admin without a second factor", () => {
    const f = run(
      scan(
        { mfaEnabled: false, isAdmin: true },
        {
          role: "user",
          mfaKey: "mfaEnabled",
          adminIndicatorKey: "isAdmin",
        },
      ),
    ).findings.find((x) => x.ruleId === ACCESS_REVIEW_RULE_IDS.noMfa);
    expect(f?.severity).toBe("critical");
  });
});

describe("dismissals partition rather than filter", () => {
  const input = () =>
    scan(
      { lastUsedAt: daysAgo(200), isAdmin: true },
      {
        role: "user",
        adminIndicatorKey: "isAdmin",
      },
    );

  it("moves the dismissed finding out of findings and into dismissed", () => {
    const review = run(input(), {}); // baseline
    expect(review.totalCount).toBe(2);

    const withDismissal = run({
      ...input(),
      dismissals: [
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.admin,
          dismissedAt: "2026-08-01T00:00:00.000Z",
          dismissedBy: "Ada",
          reason: "break-glass role, reviewed quarterly",
        },
      ],
    });
    expect(withDismissal.findings.map((f) => f.ruleId)).toEqual([ACCESS_REVIEW_RULE_IDS.stale]);
    expect(withDismissal.totalCount).toBe(1);
    expect(withDismissal.byRule[ACCESS_REVIEW_RULE_IDS.admin]).toBe(0);
    expect(withDismissal.dismissedCount).toBe(1);
    expect(withDismissal.dismissed[0]?.dismissal.dismissedBy).toBe("Ada");
    expect(withDismissal.dismissed[0]?.dismissal.reason).toBe(
      "break-glass role, reviewed quarterly",
    );
  });

  it("keeps the principal in the inventory even when every finding is dismissed", () => {
    const review = run({
      ...input(),
      dismissals: [
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.admin,
          dismissedAt: "2026-08-01T00:00:00.000Z",
          dismissedBy: null,
          reason: null,
        },
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.stale,
          dismissedAt: "2026-08-02T00:00:00.000Z",
          dismissedBy: null,
          reason: null,
        },
      ],
    });
    expect(review.findings).toEqual([]);
    expect(review.principals).toHaveLength(1);
    expect(review.dismissedCount).toBe(2);
  });

  it("keeps a dismissal for a rule that no longer matches inert", () => {
    const review = run(scan({ lastUsedAt: daysAgo(1) }), {
      // Not part of `scan`'s input; supplied through the spread below.
    });
    expect(review.findings).toEqual([]);

    const inert = run({
      ...scan({ lastUsedAt: daysAgo(1) }),
      dismissals: [
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.stale,
          dismissedAt: "2026-08-01T00:00:00.000Z",
          dismissedBy: null,
          reason: null,
        },
      ],
    });
    expect(inert.findings).toEqual([]);
    expect(inert.dismissed).toEqual([]);
    expect(inert.dismissedCount).toBe(0);
  });

  it("sorts dismissals most recent first", () => {
    const review = run({
      ...input(),
      dismissals: [
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.stale,
          dismissedAt: "2026-07-01T00:00:00.000Z",
          dismissedBy: null,
          reason: null,
        },
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.admin,
          dismissedAt: "2026-08-05T00:00:00.000Z",
          dismissedBy: null,
          reason: null,
        },
      ],
    });
    expect(review.dismissed.map((d) => d.ruleId)).toEqual([
      ACCESS_REVIEW_RULE_IDS.admin,
      ACCESS_REVIEW_RULE_IDS.stale,
    ]);
  });
});

describe("accessFindingKey", () => {
  it("joins the two halves on NUL", () => {
    expect(accessFindingKey({ resourceId: "a", ruleId: "b" })).toBe("a\u0000b");
  });

  // Resource ids are provider-native slash-paths and rule ids are
  // colon-prefixed, so any printable delimiter could be forged into a
  // collision. NUL appears in neither.
  it("cannot be forged with the punctuation either half really contains", () => {
    expect(
      accessFindingKey({
        resourceId: "projects/p/zones/z/instances/i",
        ruleId: ACCESS_REVIEW_RULE_IDS.stale,
      }),
    ).not.toBe(
      accessFindingKey({
        resourceId: "projects/p/zones/z",
        ruleId: `instances/i:${ACCESS_REVIEW_RULE_IDS.stale}`,
      }),
    );
  });
});

describe("normalizeStaleDays", () => {
  it("defaults, rounds and clamps", () => {
    expect(normalizeStaleDays(undefined)).toBe(DEFAULT_ACCESS_REVIEW_STALE_DAYS);
    expect(normalizeStaleDays(Number.NaN)).toBe(DEFAULT_ACCESS_REVIEW_STALE_DAYS);
    expect(normalizeStaleDays(30.4)).toBe(30);
    expect(normalizeStaleDays(0)).toBe(1);
    expect(normalizeStaleDays(-5)).toBe(1);
    expect(normalizeStaleDays(99_999)).toBe(3650);
  });

  it("is echoed back on the response so a surface can label the window", () => {
    expect(run(scan({}), { staleDays: 0 }).staleDays).toBe(1);
  });
});

describe("alertableAccessFindings", () => {
  it("keeps critical and high only", () => {
    const review = run(
      scan(
        { lastUsedAt: daysAgo(400), isAdmin: true },
        {
          role: "user",
          adminIndicatorKey: "isAdmin",
        },
      ),
    );
    // stale(high, because admin) + admin(high)
    expect(alertableAccessFindings(review)).toHaveLength(2);

    const lowOnly = computeAccessReview(scan({}), { now: NOW });
    expect(lowOnly.findings.map((f) => f.severity)).toEqual(["low"]);
    expect(alertableAccessFindings(lowOnly)).toEqual([]);
  });
});

describe("accessReviewToCsv", () => {
  it("emits a header plus one row per finding, open then dismissed", () => {
    const review = run({
      ...scan(
        { lastUsedAt: daysAgo(200), isAdmin: true },
        {
          role: "user",
          adminIndicatorKey: "isAdmin",
        },
      ),
      dismissals: [
        {
          resourceId: "res-1",
          ruleId: ACCESS_REVIEW_RULE_IDS.admin,
          dismissedAt: "2026-08-01T00:00:00.000Z",
          dismissedBy: "Ada",
          reason: "reviewed",
        },
      ],
    });
    const lines = accessReviewToCsv(review).trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"Severity"');
    expect(lines[1]).toContain('"open"');
    expect(lines[2]).toContain('"dismissed"');
    expect(lines[2]).toContain('"Ada"');
  });

  it("quotes every cell and doubles embedded quotes", () => {
    const input = scan({});
    input.resources = [{ ...input.resources[0]!, displayName: 'we, the "ops" team' }];
    const csv = accessReviewToCsv(computeAccessReview(input, { now: NOW }));
    expect(csv).toContain('"we, the ""ops"" team"');
  });

  // Principal names come from the customer's cloud; an evidence file that
  // executes them would be a formula-injection hole in a compliance artifact.
  it("neutralises spreadsheet formulas in provider-supplied names", () => {
    const input = scan({});
    input.resources = [{ ...input.resources[0]!, displayName: "=cmd|' /c calc'!A1" }];
    const csv = accessReviewToCsv(computeAccessReview(input, { now: NOW }));
    expect(csv).toContain('"\t=cmd');
  });
});
