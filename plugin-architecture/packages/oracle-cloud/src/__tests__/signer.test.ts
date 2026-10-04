import { describe, expect, it } from "vitest";
import {
  importPrivateKey,
  OciKeyError,
  pemToPkcs8,
  pkcs1ToPkcs8,
  signingPlan,
  signRequest,
} from "../signer.js";
import { pemOf, TEST_KEY, TEST_KEY_PAIR, TEST_PKCS8 } from "./helpers.js";

/**
 * Oracle's published signing example, from the OCI Go SDK
 * (oracle/oci-go-sdk `common/http_signer_test.go`), which reproduces
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm.
 *
 * RSASSA-PKCS1-v1_5 is deterministic, so a signer is correct exactly when it
 * builds the same signing string and signs it with RSA-SHA256. The tests check
 * the first against Oracle's expected strings and the second by verifying the
 * signature with the public half of a key generated per run, which keeps every
 * private key, including Oracle's public test key, out of the repository.
 * (The full vector, signatures included, was reproduced byte for byte when
 * this signer was written.)
 */

const CREDS = {
  tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq",
  userOcid: "ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq",
  fingerprint: "20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34",
};

// Not a real weekday (5 Jan 2014 was a Sunday): it is signed as a literal.
const DATE = "Thu, 05 Jan 2014 21:31:40 GMT";

const GET_URL =
  "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances" +
  "?availabilityDomain=Pjwf%3A%20PHX-AD-1&" +
  "compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
  "&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q";

const EXPECTED_GET =
  "date: Thu, 05 Jan 2014 21:31:40 GMT\n" +
  "(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PH" +
  "X-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2i" +
  "dnccdflvjsnog7mlr6rtdb25gilchfeyjxa&displayName=TeamXInstances&" +
  "volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q\n" +
  "host: iaas.us-phoenix-1.oraclecloud.com";

const POST_BODY = `{
    "compartmentId": "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",
    "instanceId": "ocid1.instance.oc1.phx.abuw4ljrlsfiqw6vzzxb43vyypt4pkodawglp3wqxjqofakrwvou52gb6s5a",
    "volumeId": "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q"
}`;

const EXPECTED_POST = `date: Thu, 05 Jan 2014 21:31:40 GMT
(request-target): post /20160918/volumeAttachments
host: iaas.us-phoenix-1.oraclecloud.com
content-length: 316
content-type: application/json
x-content-sha256: V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=`;

function signatureOf(authorization: string): Uint8Array {
  const b64 = /signature="([^"]+)"/.exec(authorization)?.[1] ?? "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function verifies(signingString: string, authorization: string): Promise<boolean> {
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    TEST_KEY_PAIR.publicKey,
    signatureOf(authorization) as BufferSource,
    new TextEncoder().encode(signingString),
  );
}

/** The PKCS#1 RSAPrivateKey inside a PKCS#8 PrivateKeyInfo. */
function innerPkcs1(pkcs8: Uint8Array): Uint8Array {
  let i = 0;
  const readLen = (): number => {
    const first = pkcs8[i++]!;
    if (first < 0x80) return first;
    let len = 0;
    for (let n = first & 0x7f; n > 0; n--) len = (len << 8) | pkcs8[i++]!;
    return len;
  };
  i++; // SEQUENCE
  readLen();
  i += 3; // INTEGER 0
  i++; // SEQUENCE (algorithm)
  const algorithmLength = readLen();
  i += algorithmLength;
  i++; // OCTET STRING
  const len = readLen();
  return pkcs8.slice(i, i + len);
}

describe("OCI request signing", () => {
  it("builds Oracle's documented GET signing string", async () => {
    const plan = await signingPlan({ method: "GET", url: GET_URL, date: DATE, dateHeader: "date" });
    expect(plan.signingString).toBe(EXPECTED_GET);
    expect(plan.signedHeaderNames).toEqual(["date", "(request-target)", "host"]);
  });

  it("builds Oracle's documented POST signing string, body headers included", async () => {
    const plan = await signingPlan({
      method: "POST",
      url: "https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments",
      body: POST_BODY,
      date: DATE,
      dateHeader: "date",
    });
    expect(plan.signingString).toBe(EXPECTED_POST);
    expect(plan.headers["x-content-sha256"]).toBe("V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=");
  });

  it("signs that string with RSA-SHA256 and the documented header format", async () => {
    const key = await importPrivateKey(TEST_KEY);
    const headers = await signRequest(key, CREDS, {
      method: "GET",
      url: GET_URL,
      date: DATE,
      dateHeader: "date",
    });
    expect(headers["authorization"]).toMatch(
      new RegExp(
        `^Signature version="1",keyId="${CREDS.tenancyOcid}/${CREDS.userOcid}/${CREDS.fingerprint}",algorithm="rsa-sha256",headers="date \\(request-target\\) host",signature="[A-Za-z0-9+/=]+"$`,
      ),
    );
    expect(await verifies(EXPECTED_GET, headers["authorization"]!)).toBe(true);
  });

  it("signs x-date by default and never sets the forbidden browser headers", async () => {
    const key = await importPrivateKey(TEST_KEY);
    const headers = await signRequest(key, CREDS, {
      method: "PUT",
      url: "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances/x",
      body: "",
      date: DATE,
    });
    expect(headers["x-date"]).toBe(DATE);
    expect(headers["date"]).toBeUndefined();
    expect(headers["host"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    // sha256 of the empty string, which OCI requires even for an empty body.
    expect(headers["x-content-sha256"]).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(headers["authorization"]).toContain(
      'headers="x-date (request-target) host content-length content-type x-content-sha256"',
    );
  });

  it("signs uploads without body headers (Object Storage PutObject)", async () => {
    const plan = await signingPlan({
      method: "PUT",
      url: "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b/bk/o/a.txt",
      excludeBody: true,
      headers: { "content-type": "text/plain" },
      date: DATE,
    });
    expect(plan.signedHeaderNames).toEqual(["x-date", "(request-target)", "host"]);
    expect(plan.headers["content-type"]).toBe("text/plain");
  });

  it("accepts PKCS#1 keys by wrapping them, and keys pasted with literal \\n escapes", async () => {
    const pkcs1 = innerPkcs1(TEST_PKCS8);
    expect(pkcs1ToPkcs8(pkcs1)).toEqual(TEST_PKCS8);
    const rsaPem = pemOf("RSA PRIVATE KEY", pkcs1);
    const escaped = `${TEST_KEY.replace(/\n/g, "\\n")}\nOCI_API_KEY`;
    for (const pem of [rsaPem, escaped]) {
      const key = await importPrivateKey(pem);
      const headers = await signRequest(key, CREDS, {
        method: "GET",
        url: GET_URL,
        date: DATE,
        dateHeader: "date",
      });
      expect(await verifies(EXPECTED_GET, headers["authorization"]!)).toBe(true);
    }
  });

  it("explains encrypted and public keys instead of failing opaquely", () => {
    expect(() =>
      pemToPkcs8(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
      ),
    ).toThrow(/passphrase/);
    expect(() => pemToPkcs8("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow(
      OciKeyError,
    );
    expect(() => pemToPkcs8("not a key")).toThrow(/PEM/);
  });
});
