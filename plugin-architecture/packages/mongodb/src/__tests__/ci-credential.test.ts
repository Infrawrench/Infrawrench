import { describe, expect, it } from "vitest";

import { lendMongo } from "../ci-credential.js";

describe("lendMongo", () => {
  it("lends the connection string as MONGODB_URI, secret as a whole", () => {
    const uri = "mongodb+srv://app:pw@cluster0.example.net/shop";
    expect(lendMongo(uri)).toEqual({
      env: { MONGODB_URI: uri },
      files: [],
      summary: "the connection string",
    });
    expect(() => lendMongo("")).toThrow();
  });
});
