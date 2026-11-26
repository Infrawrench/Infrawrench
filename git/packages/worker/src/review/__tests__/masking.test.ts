import { describe, expect, it } from "vitest";
import { MASK, maskSecrets } from "../masking";

describe("maskSecrets", () => {
  it("masks credentials by their shape", () => {
    const pat = `iwg_${"a".repeat(32)}`;
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(20)}.${"c".repeat(10)}`;
    const masked = maskSecrets(`pushed with ${pat}, then called the API with ${jwt}`);
    expect(masked).toBe(`pushed with ${MASK}, then called the API with ${MASK}`);
  });

  it("masks a private key block whole", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(maskSecrets(`key:\n${key}\ndone`)).toBe(`key:\n${MASK}\ndone`);
  });

  it("masks what a name says is a secret, and keeps the name", () => {
    expect(maskSecrets("DATABASE_PASSWORD=hunter2 PORT=5432")).toBe(
      `DATABASE_PASSWORD=${MASK} PORT=5432`,
    );
    expect(maskSecrets('{"apiKey": "abc123", "region": "eu"}')).toBe(
      `{"apiKey": "${MASK}", "region": "eu"}`,
    );
  });

  it("masks a password in a URL and an authorization header", () => {
    expect(maskSecrets("postgres://app:s3cret@db.internal:5432/app")).toBe(
      `postgres://app:${MASK}@db.internal:5432/app`,
    );
    expect(maskSecrets("curl -H 'Authorization: Bearer abcdefgh12345678' https://x")).toContain(
      `Bearer ${MASK}`,
    );
  });

  it("masks a token header whatever it is called", () => {
    expect(maskSecrets("X-Auth-Token: abc123def456")).toBe(`X-Auth-Token: ${MASK}`);
    expect(maskSecrets("token: Bearer abcdefgh12345678")).toBe(`token: Bearer ${MASK}`);
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "Ran `pnpm test` in src/auth: 42 passed. Decided to keep the token cache.",
      "Changed src/auth/token.ts: 3 lines. The password field is required now.",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });
});
