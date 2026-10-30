import { describe, expect, it } from "vitest";
import { countryNeedsConsent, parseTraceCountry } from "../region";

const TRACE = `fl=123f45
h=infrawrench.com
ip=203.0.113.7
ts=1761830000.123
visit_scheme=https
uag=Mozilla/5.0
colo=LHR
sliver=none
http=http/2
loc=FR
tls=TLSv1.3
sni=plaintext
warp=off
gateway=off
rbi=off
kex=X25519`;

describe("parseTraceCountry", () => {
  it("reads the loc line", () => {
    expect(parseTraceCountry(TRACE)).toBe("FR");
  });

  it("returns null without a usable loc line", () => {
    expect(parseTraceCountry("colo=LHR\n")).toBeNull();
    expect(parseTraceCountry("loc=\n")).toBeNull();
    expect(parseTraceCountry("loc=France\n")).toBeNull();
  });
});

describe("countryNeedsConsent", () => {
  it("asks in the EEA, the UK and Switzerland", () => {
    for (const country of ["DE", "IE", "NO", "IS", "LI", "GB", "CH"]) {
      expect(countryNeedsConsent(country)).toBe(true);
    }
  });

  it("does not ask elsewhere", () => {
    for (const country of ["US", "CA", "JP", "AU", "BR", "IN"]) {
      expect(countryNeedsConsent(country)).toBe(false);
    }
  });

  it("asks when the country is unknown or Tor", () => {
    expect(countryNeedsConsent(null)).toBe(true);
    expect(countryNeedsConsent("XX")).toBe(true);
    expect(countryNeedsConsent("T1")).toBe(true);
  });
});
