/**
 * Phone-number list prices.
 *
 * `IncomingPhoneNumber` carries a `type` (`local`, `mobile`, `tollfree`) but
 * no country, and the Pricing API (`GET pricing.twilio.com/v1/PhoneNumbers/Countries/{IsoCountry}`)
 * is keyed by country. The country is therefore read off the number's E.164
 * calling code, longest prefix first; inside the North American Numbering
 * Plan (+1), Canadian area codes are told apart from US ones and everything
 * else is priced as the US. Toll-free NANP numbers are shared by the US and
 * Canada and priced as US toll-free.
 *
 * The price is `current_price` (what the account pays after any discount),
 * in the response's `price_unit`.
 */

/** ITU calling codes → ISO 3166-1 alpha-2, for the countries Twilio sells numbers in most. */
const CALLING_CODES: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "234": "NG",
  "254": "KE",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "380": "UA",
  "385": "HR",
  "386": "SI",
  "420": "CZ",
  "421": "SK",
  "506": "CR",
  "507": "PA",
  "593": "EC",
  "598": "UY",
  "852": "HK",
  "886": "TW",
  "966": "SA",
  "971": "AE",
  "972": "IL",
};

/** Canadian NANP area codes (CNAC), so +1 numbers in Canada are priced as Canada. */
const CANADIAN_AREA_CODES = new Set([
  "204",
  "226",
  "236",
  "249",
  "250",
  "257",
  "263",
  "289",
  "306",
  "343",
  "354",
  "365",
  "367",
  "368",
  "382",
  "387",
  "403",
  "416",
  "418",
  "428",
  "431",
  "437",
  "438",
  "450",
  "460",
  "468",
  "474",
  "506",
  "514",
  "519",
  "548",
  "579",
  "581",
  "584",
  "587",
  "604",
  "613",
  "639",
  "647",
  "672",
  "683",
  "705",
  "709",
  "742",
  "753",
  "778",
  "780",
  "782",
  "807",
  "819",
  "825",
  "867",
  "873",
  "879",
  "902",
  "905",
  "942",
]);

/** ISO country for an E.164 number, or undefined when the calling code is not in the table. */
export function countryOfNumber(e164: string): string | undefined {
  const digits = e164.replace(/[^\d]/g, "");
  if (!e164.trim().startsWith("+") || digits.length < 4) return undefined;
  if (digits.startsWith("1")) {
    return CANADIAN_AREA_CODES.has(digits.slice(1, 4)) ? "CA" : "US";
  }
  for (const len of [3, 2, 1]) {
    const iso = CALLING_CODES[digits.slice(0, len)];
    if (iso) return iso;
  }
  return undefined;
}

/** `toll free`, `toll-free` and `tollfree` are the same type in different Twilio APIs. */
export function normalizeNumberType(type: string | null | undefined): string {
  return (type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

export interface CountryNumberPrices {
  isoCountry: string;
  country?: string;
  priceUnit: string;
  /** Normalised number type → current monthly price. */
  prices: Map<string, number>;
}

export interface TwilioPhoneNumberCountry {
  country?: string | null;
  iso_country?: string | null;
  price_unit?: string | null;
  phone_number_prices?: Array<{
    number_type?: string | null;
    base_price?: string | number | null;
    current_price?: string | number | null;
  }> | null;
}

export function parseCountryPrices(body: TwilioPhoneNumberCountry): CountryNumberPrices {
  const prices = new Map<string, number>();
  for (const p of body.phone_number_prices ?? []) {
    const value = Number(p.current_price ?? p.base_price);
    if (p.number_type && Number.isFinite(value))
      prices.set(normalizeNumberType(p.number_type), value);
  }
  return {
    isoCountry: (body.iso_country ?? "").toUpperCase(),
    ...(body.country ? { country: body.country } : {}),
    priceUnit: (body.price_unit ?? "USD").toUpperCase(),
    prices,
  };
}
