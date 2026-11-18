import { describe, expect, it } from "vitest";
import { mapAccount, mapDatabase } from "../listers.js";
import type { LinodeDatabase } from "../types.js";

describe("capacity fields", () => {
  it("stores a database's used and total disk as reported", () => {
    const db = mapDatabase(
      {
        id: 7,
        label: "pg",
        engine: "postgresql",
        used_disk_size_gb: 2,
        total_disk_size_gb: 15,
      } as LinodeDatabase,
      "acct",
    );
    expect(db.fields["diskUsedGb"]).toBe(2);
    expect(db.fields["diskTotalGb"]).toBe(15);
  });

  it("leaves a database's disk fields out when the response has none", () => {
    const db = mapDatabase({ id: 7, label: "pg", engine: "mysql" } as LinodeDatabase, "acct");
    expect(db.fields["diskUsedGb"]).toBeUndefined();
    expect(db.fields["diskTotalGb"]).toBeUndefined();
  });

  it("stores the month's transfer used against the pool", () => {
    const account = mapAccount({ email: "a@example.com" }, { used: 12, quota: 9141 }, "acct");
    expect(account.fields["transferUsedGb"]).toBe(12);
    expect(account.fields["transferQuotaGb"]).toBe(9141);
  });
});
