import { describe, it, expect, vi } from "vitest";
import {
  listTurnstileWidgets,
  createTurnstileWidget,
  editTurnstileWidget,
  getWidgetSecret,
  deleteTurnstileWidget,
} from "../clients/turnstile-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const WIDGET = {
  sitekey: "0xKEY",
  name: "main",
  mode: "managed",
  domains: ["a.com", "b.com"],
  region: "world",
  secret: "0xSECRET",
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function tsApi(over: Record<string, unknown> = {}) {
  const widgets = {
    list: vi.fn(() => asyncIter([WIDGET])),
    get: vi.fn(async () => WIDGET),
    create: vi.fn(async () => WIDGET),
    update: vi.fn(async () => WIDGET),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { turnstile: { widgets } }, ...over });
}

describe("turnstile-client", () => {
  it("listTurnstileWidgets maps a widget keyed by sitekey", async () => {
    const api = tsApi();
    const out = await listTurnstileWidgets(api, "acct");
    expect(out[0].id).toBe("acct:turnstile-widget:0xKEY");
    expect(out[0].externalId).toBe("0xKEY");
    expect(out[0].fields.domains).toBe("a.com, b.com");
    expect(out[0].resolvedOutputs?.siteKey).toBe("0xKEY");
  });

  it("listTurnstileWidgets surfaces a permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        turnstile: {
          widgets: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listTurnstileWidgets(api, "acct")).rejects.toThrow(/Turnstile:Read permission/);
  });

  it("createTurnstileWidget parses domains CSV", async () => {
    const api = tsApi();
    await createTurnstileWidget(api, "acct", {
      name: "main",
      domains: "a.com, b.com",
      mode: "managed",
    });
    expect(api.cf.turnstile.widgets.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "main", domains: ["a.com", "b.com"], mode: "managed" }),
    );
  });

  it("editTurnstileWidget rebuilds the body with toggles", async () => {
    const api = tsApi();
    await editTurnstileWidget(api, "acct", "0xKEY", {
      name: "main",
      domains: "a.com",
      botFightMode: "true",
    });
    expect(api.cf.turnstile.widgets.update).toHaveBeenCalledWith(
      "0xKEY",
      expect.objectContaining({ domains: ["a.com"], bot_fight_mode: true }),
    );
  });

  it("getWidgetSecret returns the secret", async () => {
    const api = tsApi();
    expect(await getWidgetSecret(api, "0xKEY")).toBe("0xSECRET");
    expect(api.cf.turnstile.widgets.get).toHaveBeenCalledWith("0xKEY", { account_id: "acct-cf" });
  });

  it("deleteTurnstileWidget calls delete", async () => {
    const api = tsApi();
    await deleteTurnstileWidget(api, "0xKEY");
    expect(api.cf.turnstile.widgets.delete).toHaveBeenCalledWith("0xKEY", {
      account_id: "acct-cf",
    });
  });
});
