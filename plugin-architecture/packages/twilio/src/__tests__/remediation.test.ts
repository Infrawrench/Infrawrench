import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { twilioRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const SID = "PN0123456789abcdef0123456789abcdef";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "+14155550100",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return twilioRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "nothing answers",
  resource,
});

describe("twilioRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(twilioRemediationCommands);
  });

  it("fetches and releases an unrouted number", () => {
    expect(lines(orphan(res("phone-number", SID, { phoneNumber: "+14155550100" }))))
      .toMatchInlineSnapshot(`
      [
        "- twilio api:core:incoming-phone-numbers:fetch --sid PN0123456789abcdef0123456789abcdef",
        "! twilio api:core:incoming-phone-numbers:remove --sid PN0123456789abcdef0123456789abcdef",
      ]
    `);
  });

  it("names the owning subaccount, quoted", () => {
    expect(
      lines(
        orphan(
          res("phone-number", SID, {
            phoneNumber: "+14155550100",
            subaccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxsub0001; echo",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- twilio api:core:incoming-phone-numbers:fetch --sid PN0123456789abcdef0123456789abcdef --account-sid 'ACxxxxxxxxxxxxxxxxxxxxxxxxsub0001; echo'",
        "! twilio api:core:incoming-phone-numbers:remove --sid PN0123456789abcdef0123456789abcdef --account-sid 'ACxxxxxxxxxxxxxxxxxxxxxxxxsub0001; echo'",
      ]
    `);
  });

  it("returns nothing for unknown types, malformed sids and other kinds", () => {
    expect(lines(orphan(res("messaging-service", "MG123")))).toEqual([]);
    expect(lines(orphan(res("phone-number", "PN; rm -rf ~")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("phone-number", SID) })).toEqual([]);
  });
});
