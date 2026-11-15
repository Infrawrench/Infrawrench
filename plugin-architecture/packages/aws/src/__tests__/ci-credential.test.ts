import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";

import { lendAwsSession, sessionFromResponse, stsHost } from "../ci-credential.js";
import { parseXml } from "../xml.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

// The shape of STS's answer (API reference sample), with made-up values.
const answer = `<GetSessionTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetSessionTokenResult>
    <Credentials>
      <SessionToken>
       fixture-session-token
      </SessionToken>
      <SecretAccessKey>fixture-secret</SecretAccessKey>
      <Expiration>2026-11-15T20:00:00Z</Expiration>
      <AccessKeyId>ASIAFIXTURE</AccessKeyId>
    </Credentials>
  </GetSessionTokenResult>
  <ResponseMetadata><RequestId>58c5dbae</RequestId></ResponseMetadata>
</GetSessionTokenResponse>`;

const session = {
  accessKeyId: "ASIAFIXTURE",
  secretAccessKey: "fixture-secret",
  sessionToken: "fixture-session-token",
  expiration: "2026-11-15T20:00:00Z",
};

describe("sessionFromResponse", () => {
  it("reads the credentials STS returns, trimmed", () => {
    expect(sessionFromResponse(parseXml(answer))).toEqual(session);
  });

  it("refuses an answer without credentials", () => {
    expect(() =>
      sessionFromResponse(
        parseXml("<GetSessionTokenResponse><GetSessionTokenResult/></GetSessionTokenResponse>"),
      ),
    ).toThrow("without credentials");
  });
});

describe("stsHost", () => {
  it("is the region's own endpoint, in China too", () => {
    expect(stsHost("eu-west-2")).toBe("sts.eu-west-2.amazonaws.com");
    expect(stsHost("cn-north-1")).toBe("sts.cn-north-1.amazonaws.com.cn");
  });
});

describe("lendAwsSession", () => {
  it("lends a session for the run as variables and a named profile, the keys masked", async () => {
    const asked: number[] = [];
    const material = await lendAwsSession(
      async (seconds) => {
        asked.push(seconds);
        return session;
      },
      "eu-west-2",
      { alias: "production", ttlSeconds: 4 * 60 * 60 },
    );
    expect(asked).toEqual([14_400]);
    expect(Object.keys(material.env)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
    ]);
    expect(material.env["AWS_SESSION_TOKEN"]).toBe("fixture-session-token");
    // The region is shown; the three parts of the session are not.
    expect(secrets(material.env["AWS_REGION"]!)).toEqual([]);
    expect(text(material.env["AWS_REGION"]!)).toBe("eu-west-2");
    const [credentials, config] = material.files;
    expect(credentials!.path).toBe("/root/.aws/credentials");
    expect(credentials!.mode).toBe("600");
    expect(text(credentials!.content)).toBe(
      "[production]\naws_access_key_id = ASIAFIXTURE\naws_secret_access_key = fixture-secret\naws_session_token = fixture-session-token\n",
    );
    expect(secrets(credentials!.content)).toEqual([
      "ASIAFIXTURE",
      "fixture-secret",
      "fixture-session-token",
    ]);
    expect(config!.path).toBe("/root/.aws/config");
    expect(text(config!.content)).toBe("[profile production]\nregion = eu-west-2\n");
    expect(material.expiresAt).toBe("2026-11-15T20:00:00Z");
    expect(material.summary).toBe("STS session credentials, 240 minutes");
  });

  it("asks for what STS allows: at least 15 minutes, at most 36 hours", async () => {
    const asked: number[] = [];
    const mint = async (seconds: number) => {
      asked.push(seconds);
      return session;
    };
    await lendAwsSession(mint, "us-east-1", { alias: "a", ttlSeconds: 60 });
    await lendAwsSession(mint, "us-east-1", { alias: "a", ttlSeconds: 7 * 24 * 60 * 60 });
    await lendAwsSession(mint, "us-east-1", { alias: "a", ttlSeconds: 1000.5 });
    expect(asked).toEqual([900, 129_600, 1001]);
  });

  it("refuses rather than lending the stored key when STS will not mint", async () => {
    await expect(
      lendAwsSession(
        async () => {
          throw new Error("AWS sts POST / failed: 403: InvalidClientTokenId");
        },
        "us-east-1",
        { alias: "a", ttlSeconds: 3600 },
      ),
    ).rejects.toThrow(
      "STS would not mint session credentials for this connection's access key (AWS sts POST / failed: 403: InvalidClientTokenId)",
    );
  });
});
