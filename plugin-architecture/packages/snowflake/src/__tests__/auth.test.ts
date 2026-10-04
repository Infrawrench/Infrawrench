import { describe, expect, it } from "vitest";
import { parseAccount, snowsightUrl } from "../account.js";
import { SnowflakeAuth, parseCredential, publicKeyFingerprint, signJwt } from "../auth.js";

describe("parseAccount", () => {
  it.each([
    ["myorg-myaccount", "myorg-myaccount.snowflakecomputing.com", "MYORG-MYACCOUNT"],
    ["MyOrg.My_Account", "myorg-my-account.snowflakecomputing.com", "MYORG-MY_ACCOUNT"],
    [
      "https://myorg-myaccount.snowflakecomputing.com/console",
      "myorg-myaccount.snowflakecomputing.com",
      "MYORG-MYACCOUNT",
    ],
    [
      "https://app.snowflake.com/myorg/my_account/#/homepage",
      "myorg-my-account.snowflakecomputing.com",
      "MYORG-MY_ACCOUNT",
    ],
    ["xy12345.us-east-2.aws", "xy12345.us-east-2.aws.snowflakecomputing.com", "XY12345"],
    ["xy12345", "xy12345.snowflakecomputing.com", "XY12345"],
    [
      "myorg-myaccount.privatelink.snowflakecomputing.com",
      "myorg-myaccount.privatelink.snowflakecomputing.com",
      "MYORG-MYACCOUNT",
    ],
  ])("%s", (input, host, jwtAccount) => {
    const a = parseAccount(input);
    expect(a.host).toBe(host);
    expect(a.jwtAccount).toBe(jwtAccount);
  });

  it("rejects empty and garbage input", () => {
    expect(() => parseAccount("")).toThrow(/account identifier/);
    expect(() => parseAccount("not an account!")).toThrow(/does not look like/);
  });

  it("links to Snowsight for org-account identifiers", () => {
    expect(snowsightUrl(parseAccount("myorg-myaccount"))).toBe(
      "https://app.snowflake.com/myorg/myaccount/",
    );
  });
});

async function newKeyPem(): Promise<{ pem: string; spki: Uint8Array; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, spki, publicKey: pair.publicKey };
}

const b64urlDecode = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

describe("credentials", () => {
  it("treats a single-line secret as a programmatic access token", async () => {
    const cred = parseCredential("  abc.def-ghi  ");
    expect(cred).toEqual({ kind: "token", token: "abc.def-ghi" });
    const auth = new SnowflakeAuth(cred, "MYORG-MYACCOUNT", "me");
    expect(await auth.headers()).toEqual({
      Authorization: "Bearer abc.def-ghi",
      "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    });
  });

  it("explains encrypted keys", () => {
    expect(() =>
      parseCredential(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
      ),
    ).toThrow(/encrypted/);
  });

  it("signs a key-pair JWT with Snowflake's claims and fingerprint", async () => {
    const { pem, spki, publicKey } = await newKeyPem();
    const cred = parseCredential(pem);
    expect(cred.kind).toBe("keypair");
    if (cred.kind !== "keypair") return;

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki as BufferSource));
    const expected = `SHA256:${btoa(String.fromCharCode(...digest))}`;
    expect(await publicKeyFingerprint(cred.pkcs8)).toBe(expected);

    const jwt = await signJwt(cred.pkcs8, "MYORG-MY_ACCOUNT", "svc_user", 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(b64urlDecode(h!))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(b64urlDecode(p!))).toEqual({
      iss: `MYORG-MY_ACCOUNT.SVC_USER.${expected}`,
      sub: "MYORG-MY_ACCOUNT.SVC_USER",
      iat: 1_700_000_000,
      exp: 1_700_003_540,
    });
    const sig = Uint8Array.from(b64urlDecode(s!), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sig as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
    expect(ok).toBe(true);

    const auth = new SnowflakeAuth(cred, "MYORG-MYACCOUNT", "me");
    const headers = await auth.headers();
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe("KEYPAIR_JWT");
    expect(headers["Authorization"]).toMatch(/^Bearer ey/);
  });
});
