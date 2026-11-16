import { describe, expect, it } from "vitest";

import { lendMongo } from "../ci-credential.js";

describe("lendMongo", () => {
  it("lends the string, and its password bare so that is masked too", () => {
    const uri = "mongodb+srv://app:p%23ss%2Fw%40rd@cluster0.example.net/shop";
    expect(lendMongo(uri)).toEqual({
      env: { MONGODB_URI: uri, MONGODB_USERNAME: [{ text: "app" }], MONGODB_PASSWORD: "p#ss/w@rd" },
      files: [],
      summary: "the connection string",
    });
    expect(() => lendMongo("")).toThrow();
  });

  it("lends a string with no password as it is", () => {
    expect(lendMongo("mongodb://db:27017/x").env).toEqual({ MONGODB_URI: "mongodb://db:27017/x" });
  });
});
