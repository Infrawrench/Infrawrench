import { describe, expect, it } from "vitest";
import { isIncompleteListError, reportUnreadListPart } from "@infrawrench/plugin-base";
import { runListChecked } from "../runtime/request-scope";

describe("reportUnreadListPart at the host", () => {
  it("is taken by a read that keeps unread rows, as the sync does", async () => {
    let parts: unknown[] = [];
    const taken = await runListChecked(
      async () => reportUnreadListPart({ idPrefixes: [""] }),
      (p) => {
        parts = p;
      },
    );
    expect(taken).toBe(true);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("fails a read that replaces what is stored, even if the plugin returns a list", async () => {
    const read = runListChecked(async () => {
      expect(reportUnreadListPart({ idPrefixes: [""] })).toBe(false);
      return [];
    });
    await expect(read).rejects.toSatisfy(isIncompleteListError);
  });

  it("tells a plugin outside any checked read that nobody keeps the rows", () => {
    expect(reportUnreadListPart({ idPrefixes: [""] })).toBe(false);
  });
});
