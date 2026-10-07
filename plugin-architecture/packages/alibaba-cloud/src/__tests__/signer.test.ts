import { describe, expect, it } from "vitest";
import { canonicalQuery, percentEncode, signAcs3, signOssV4 } from "../signer.js";

describe("ACS3-HMAC-SHA256", () => {
  // Alibaba's published worked example:
  // https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature
  it("reproduces the documented RunInstances signature", async () => {
    const { headers, canonicalRequest } = await signAcs3(
      { accessKeyId: "YourAccessKeyId", accessKeySecret: "YourAccessKeySecret" },
      {
        method: "POST",
        host: "ecs.cn-shanghai.aliyuncs.com",
        path: "/",
        query: {
          ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
          RegionId: "cn-shanghai",
        },
        action: "RunInstances",
        version: "2014-05-26",
        body: "",
        date: "2023-10-26T10:22:32Z",
        nonce: "3156853299f313e23d1673dc12e1703d",
      },
    );
    expect(canonicalRequest).toBe(
      [
        "POST",
        "/",
        "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
        "host:ecs.cn-shanghai.aliyuncs.com\nx-acs-action:RunInstances\nx-acs-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-acs-date:2023-10-26T10:22:32Z\nx-acs-signature-nonce:3156853299f313e23d1673dc12e1703d\nx-acs-version:2014-05-26\n",
        "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(headers["authorization"]).toBe(
      "ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    );
    // Browsers refuse to set Host; it is signed, never sent.
    expect(headers["host"]).toBeUndefined();
  });

  it("percent-encodes the way Alibaba documents", () => {
    expect(percentEncode("a b*c~d!")).toBe("a%20b%2Ac~d%21");
    expect(canonicalQuery({ b: "2", a: "x y", "Tag.1.Key": "k" })).toBe("Tag.1.Key=k&a=x%20y&b=2");
  });
});

describe("OSS4-HMAC-SHA256", () => {
  // TestV4AuthHeader in aliyun/alibabacloud-oss-go-sdk-v2 (oss/signer/signer_test.go).
  it("reproduces the Go SDK v2 vector", async () => {
    const headers = await signOssV4(
      { accessKeyId: "ak", accessKeySecret: "sk" },
      {
        method: "PUT",
        region: "cn-hangzhou",
        bucket: "bucket",
        key: "1234+-/123/1.txt",
        // url.Values.Encode() of the vector's parameters.
        rawQuery: "%2Bparam1=value3&%2Bparam2=&param1=value1&param2=&%7Cparam1=value4&%7Cparam2=",
        headers: {
          "x-oss-head1": "value",
          abc: "value",
          ZAbc: "value",
          XYZ: "value",
          "content-type": "text/plain",
        },
        date: new Date(1702743657 * 1000),
      },
    );
    expect(headers["authorization"]).toBe(
      "OSS4-HMAC-SHA256 Credential=ak/20231216/cn-hangzhou/oss/aliyun_v4_request,Signature=e21d18daa82167720f9b1047ae7e7f1ce7cb77a31e8203a7d5f4624fa0284afe",
    );
    expect(headers["x-oss-date"]).toBe("20231216T162057Z");
  });
});
