import { describe, expect, it } from "vitest";
import { productOf, selectLeafCategories } from "../categories.js";
import { countryOfNumber, normalizeNumberType, parseCountryPrices } from "../pricing.js";

const priced = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("selectLeafCategories", () => {
  it("drops prefix rollups and totalprice", () => {
    expect(
      selectLeafCategories(
        priced({
          totalprice: 10,
          sms: 6,
          "sms-outbound": 5,
          "sms-outbound-longcode": 5,
          "sms-inbound": 1,
          calls: 4,
          "calls-inbound": 4,
          "calls-inbound-local": 4,
        }),
      ),
    ).toEqual(["calls-inbound-local", "sms-inbound", "sms-outbound-longcode"]);
  });

  it("drops explicit rollups only when a child is priced", () => {
    expect(selectLeafCategories(priced({ pv: 3, "group-rooms-participant-minutes": 3 }))).toEqual([
      "group-rooms-participant-minutes",
    ]);
    expect(selectLeafCategories(priced({ pv: 3 }))).toEqual(["pv"]);
    expect(selectLeafCategories(priced({ lookups: 2, "carrier-lookups": 2 }))).toEqual([
      "carrier-lookups",
    ]);
  });

  it("never treats the double-counted Authy categories as leaves", () => {
    expect(selectLeafCategories(priced({ "authy-sms-outbound": 1, "sms-outbound": 1 }))).toEqual([
      "sms-outbound",
    ]);
  });

  it("keeps calls when only its sibling SIP and Client categories are priced", () => {
    expect(selectLeafCategories(priced({ calls: 2, "calls-sip": 1, "calls-client": 1 }))).toEqual([
      "calls",
      "calls-client",
      "calls-sip",
    ]);
  });

  it("ignores zero-priced categories", () => {
    expect(selectLeafCategories(priced({ sms: 1, "sms-inbound": 0 }))).toEqual(["sms"]);
  });
});

describe("productOf", () => {
  it.each([
    ["sms-outbound-longcode", "SMS"],
    ["a2p-registration-fees", "SMS"],
    ["mms-inbound", "MMS"],
    ["channels-whatsapp-template-marketing", "WhatsApp"],
    ["verify-whatsapp-template-business-initiated", "Verify"],
    ["authy-phone-verifications", "Verify"],
    ["phonenumbers-local", "Phone Numbers"],
    ["shortcodes-vanity", "Phone Numbers"],
    ["carrier-lookups", "Lookup"],
    ["calls-inbound-local", "Voice"],
    ["recordingstorage", "Voice"],
    ["trunking-origination", "Elastic SIP Trunking"],
    ["group-rooms-participant-minutes", "Video"],
    ["something-new", "Other"],
  ])("%s → %s", (category, product) => {
    expect(productOf(category)).toBe(product);
  });
});

describe("phone-number pricing", () => {
  it("reads the country off the calling code", () => {
    expect(countryOfNumber("+14155550100")).toBe("US");
    expect(countryOfNumber("+14165550100")).toBe("CA");
    expect(countryOfNumber("+447700900123")).toBe("GB");
    expect(countryOfNumber("+353861234567")).toBe("IE");
    expect(countryOfNumber("+61412345678")).toBe("AU");
    expect(countryOfNumber("4155550100")).toBeUndefined();
  });

  it("normalises number types across APIs", () => {
    expect(normalizeNumberType("toll free")).toBe("tollfree");
    expect(normalizeNumberType("tollfree")).toBe("tollfree");
    expect(normalizeNumberType("Local")).toBe("local");
  });

  it("parses the Pricing API country document", () => {
    const parsed = parseCountryPrices({
      iso_country: "US",
      price_unit: "USD",
      phone_number_prices: [
        { number_type: "local", base_price: "1.15", current_price: "1.15" },
        { number_type: "toll free", base_price: "2.15", current_price: "2.00" },
      ],
    });
    expect(parsed.prices.get("local")).toBe(1.15);
    expect(parsed.prices.get("tollfree")).toBe(2);
  });
});
