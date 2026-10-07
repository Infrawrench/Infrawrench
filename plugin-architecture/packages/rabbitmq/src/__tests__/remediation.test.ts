import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { rabbitmqRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function queue(fields: RemediationResource["fields"]): RemediationResource {
  return { resourceTypeId: "rabbitmq-queue", displayName: "q", externalId: "x", fields };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "idle",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return rabbitmqRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("rabbitmqRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(rabbitmqRemediationCommands);
  });

  it("deletes an idle queue only if still empty and unused", () => {
    expect(lines(orphan(queue({ vhost: "/", name: "orders.retry" })))).toMatchInlineSnapshot(`
      [
        "! rabbitmqctl delete_queue -p / orders.retry --if-empty --if-unused",
        "! curl -sS -X DELETE -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" "$RABBITMQ_MANAGEMENT_URL"'/api/queues/%2F/orders.retry?if-empty=true&if-unused=true'",
      ]
    `);
  });

  it("declares the management API placeholders on the curl variant", () => {
    const [, curl] = rabbitmqRemediationCommands(orphan(queue({ vhost: "prod", name: "q" })));
    expect(curl?.placeholders?.map((p) => p.name)).toEqual([
      "RABBITMQ_MANAGEMENT_URL",
      "RABBITMQ_USER",
      "RABBITMQ_PASSWORD",
    ]);
  });

  it("quotes hostile names and encodes them in the URL", () => {
    const [ctl, curl] = lines(orphan(queue({ vhost: "a b", name: "x; rm -rf ~" })));
    expect(ctl).toBe("! rabbitmqctl delete_queue -p 'a b' 'x; rm -rf ~' --if-empty --if-unused");
    expect(curl).toContain("'/api/queues/a%20b/x%3B%20rm%20-rf%20~?if-empty=true&if-unused=true'");
  });

  it("returns nothing without a vhost or name, or for other kinds and types", () => {
    expect(rabbitmqRemediationCommands(orphan(queue({ name: "q" })))).toEqual([]);
    expect(rabbitmqRemediationCommands(orphan(queue({ vhost: "/" })))).toEqual([]);
    expect(
      rabbitmqRemediationCommands({
        kind: "sleep-schedule",
        resource: queue({ vhost: "/", name: "q" }),
      }),
    ).toEqual([]);
    expect(
      rabbitmqRemediationCommands(
        orphan({
          resourceTypeId: "rabbitmq-exchange",
          displayName: "e",
          externalId: "e",
          fields: { vhost: "/", name: "e" },
        }),
      ),
    ).toEqual([]);
  });
});
