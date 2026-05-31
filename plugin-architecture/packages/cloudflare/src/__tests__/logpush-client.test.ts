import { describe, it, expect, vi } from "vitest";
import {
  listAllLogpushJobs,
  createLogpushJob,
  editLogpushJob,
  deleteLogpushJob,
} from "../clients/logpush-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const JOB = {
  id: "j1",
  name: "http-logs",
  enabled: true,
  dataset: "http_requests",
  destination_conf: "s3://bucket/path",
  frequency: "high",
};

function lpApi(over: Record<string, unknown> = {}) {
  const jobs = {
    list: vi.fn(() => asyncIter([JOB])),
    create: vi.fn(async () => JOB),
    update: vi.fn(async () => JOB),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { logpush: { jobs } }, ...over });
}

describe("logpush-client", () => {
  it("listAllLogpushJobs maps a job and derives destination type", async () => {
    const api = lpApi();
    const out = await listAllLogpushJobs(api, "acct");
    expect(out[0].id).toBe("acct:logpush-job:z1/j1");
    expect(out[0].fields.destinationType).toBe("s3");
    expect(out[0].fields.dataset).toBe("http_requests");
  });

  it("listAllLogpushJobs skips null entries", async () => {
    const api = lpApi({ cf: { logpush: { jobs: { list: vi.fn(() => asyncIter([null, JOB])) } } } });
    const out = await listAllLogpushJobs(api, "acct");
    expect(out).toHaveLength(1);
  });

  it("createLogpushJob sends destination + dataset", async () => {
    const api = lpApi();
    await createLogpushJob(
      api,
      "acct",
      { destinationConf: "s3://bucket/path", dataset: "http_requests", name: "http-logs" },
      "z1",
    );
    expect(api.cf.logpush.jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        destination_conf: "s3://bucket/path",
        dataset: "http_requests",
        name: "http-logs",
      }),
    );
  });

  it("createLogpushJob throws without a zone", async () => {
    await expect(createLogpushJob(lpApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("createLogpushJob throws on a null response", async () => {
    const api = lpApi({
      cf: { logpush: { jobs: { create: vi.fn(async () => null) } } },
    });
    await expect(createLogpushJob(api, "acct", { dataset: "d" }, "z1")).rejects.toThrow(
      /failed to create logpush job/,
    );
  });

  it("editLogpushJob sends PATCH fields", async () => {
    const api = lpApi();
    await editLogpushJob(api, "acct", "z1/j1", { enabled: "false", frequency: "low" });
    expect(api.cf.logpush.jobs.update).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ zone_id: "z1", enabled: false, frequency: "low" }),
    );
  });

  it("editLogpushJob throws on a malformed id", async () => {
    await expect(editLogpushJob(lpApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid logpush job ID",
    );
  });

  it("deleteLogpushJob calls delete", async () => {
    const api = lpApi();
    await deleteLogpushJob(api, "z1/j1");
    expect(api.cf.logpush.jobs.delete).toHaveBeenCalledWith("j1", { zone_id: "z1" });
  });

  it("deleteLogpushJob throws on a malformed id", async () => {
    await expect(deleteLogpushJob(lpApi(), "bad")).rejects.toThrow("Invalid logpush job ID");
  });
});
