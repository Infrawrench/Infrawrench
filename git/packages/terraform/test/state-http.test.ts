import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryStateStore,
  handleStateRequest,
  restoreVersion,
  unlockState,
  withSerial,
  type LockInfo,
  type StateAuth,
} from "../src/index.js";
import { md5 } from "../src/util/md5.js";

const STATE_URL = "https://git.example/acme/infra/terraform/prod/state";

const WRITER: StateAuth = {
  principal: "user:w",
  canRead: true,
  canLock: true,
  canWrite: true,
  canAdmin: false,
};
const ADMIN: StateAuth = {
  principal: "user:a",
  canRead: true,
  canLock: true,
  canWrite: true,
  canAdmin: true,
};
const READER: StateAuth = {
  principal: "user:r",
  canRead: true,
  canLock: false,
  canWrite: false,
  canAdmin: false,
};
const NOBODY: StateAuth = {
  principal: null,
  canRead: false,
  canLock: false,
  canWrite: false,
  canAdmin: false,
};

function state(serial: number, lineage = "lineage-a", extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      version: 4,
      terraform_version: "1.9.0",
      serial,
      lineage,
      outputs: {},
      resources: [],
      ...extra,
    },
    null,
    2,
  );
}

function lockInfo(id: string, who = "astrid@laptop"): LockInfo {
  return {
    ID: id,
    Operation: "OperationTypeApply",
    Info: "",
    Who: who,
    Version: "1.9.0",
    Created: "2026-11-25T12:00:00Z",
    Path: "",
  };
}

function call(
  store: MemoryStateStore,
  auth: StateAuth,
  method: string,
  path = "",
  body?: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return handleStateRequest(
    new Request(`${STATE_URL}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      ...(headers ? { headers } : {}),
    }),
    store,
    auth,
  );
}

describe("md5", () => {
  it("agrees with Node's on every block boundary", () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const input = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
      expect(Buffer.from(md5(input)).toString("hex")).toBe(
        createHash("md5").update(input).digest("hex"),
      );
    }
  });
});

describe("the http backend's answers", () => {
  it("answers 401 with a Basic challenge when nobody is signed in", async () => {
    const response = await call(new MemoryStateStore(), NOBODY, "GET");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm="/);
  });

  it("answers 404 for an empty workspace and never for a refused read", async () => {
    const store = new MemoryStateStore();
    expect((await call(store, READER, "GET")).status).toBe(404);
    // Terraform reads a 404 as "no state" and would plan to create everything.
    const noRead: StateAuth = { ...READER, canRead: false };
    expect((await call(store, noRead, "GET")).status).toBe(403);
  });

  it("stores a state and gives the same bytes back", async () => {
    const store = new MemoryStateStore();
    const body = state(1);
    expect((await call(store, WRITER, "POST", "", body)).status).toBe(200);
    const read = await call(store, READER, "GET");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/json");
    expect(await read.text()).toBe(body);
    const head = await call(store, READER, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const [version] = await store.versions({ limit: 10 });
    expect(version).toMatchObject({ serial: 1, lineage: "lineage-a", createdBy: "user:w" });
    expect(version?.sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("checks Content-MD5 when Terraform sends it", async () => {
    const store = new MemoryStateStore();
    const body = state(1);
    const good = createHash("md5").update(body).digest("base64");
    const bad = createHash("md5").update("other").digest("base64");
    expect((await call(store, WRITER, "POST", "", body, { "content-md5": bad })).status).toBe(400);
    expect((await call(store, WRITER, "POST", "", body, { "content-md5": good })).status).toBe(200);
  });

  it("refuses what is not a version 4 state", async () => {
    const store = new MemoryStateStore();
    for (const body of [
      "not json",
      "[]",
      JSON.stringify({ version: 3, serial: 1, lineage: "x" }),
    ]) {
      expect((await call(store, WRITER, "POST", "", body)).status).toBe(400);
    }
    expect((await call(store, WRITER, "POST", "", state(-1))).status).toBe(400);
    expect((await call(store, WRITER, "POST", "", state(1, ""))).status).toBe(400);
  });

  it("refuses a state past the size limit", async () => {
    const response = await handleStateRequest(
      new Request(STATE_URL, {
        method: "POST",
        body: state(1, "lineage-a", { pad: "x".repeat(4096) }),
      }),
      new MemoryStateStore(),
      WRITER,
      { maxBytes: 1024 },
    );
    expect(response.status).toBe(413);
  });

  it("orders versions by serial and keeps lineages apart", async () => {
    const store = new MemoryStateStore();
    expect((await call(store, WRITER, "POST", "", state(3))).status).toBe(200);
    // The same document again: a retried request, not a new version.
    expect((await call(store, WRITER, "POST", "", state(3))).status).toBe(200);
    expect(await store.versions({ limit: 10 })).toHaveLength(1);

    const reused = await call(
      store,
      WRITER,
      "POST",
      "",
      state(3, "lineage-a", { outputs: { a: 1 } }),
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({
      conflict: "serial-reused",
      current: { serial: 3 },
    });

    const behind = await call(store, WRITER, "POST", "", state(2));
    expect(behind.status).toBe(409);
    expect(await behind.json()).toMatchObject({ conflict: "serial-behind" });

    const foreign = await call(store, WRITER, "POST", "", state(9, "lineage-b"));
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({ conflict: "lineage" });

    expect((await call(store, WRITER, "POST", "", state(4))).status).toBe(200);
    expect((await store.versions({ limit: 10 })).map((v) => v.serial)).toEqual([4, 3]);
  });

  it("locks with LOCK or POST and answers 423 with the holder's info", async () => {
    for (const [method, path] of [
      ["LOCK", ""],
      ["POST", "/lock"],
      ["LOCK", "/lock"],
    ] as const) {
      const store = new MemoryStateStore();
      const first = await call(store, WRITER, method, path, JSON.stringify(lockInfo("lock-1")));
      expect(first.status).toBe(200);
      const second = await call(
        store,
        WRITER,
        method,
        path,
        JSON.stringify(lockInfo("lock-2", "ci")),
      );
      expect(second.status).toBe(423);
      expect(await second.json()).toEqual(lockInfo("lock-1"));
      // The same lock again is a retry of a request whose answer was lost.
      const again = await call(store, WRITER, method, path, JSON.stringify(lockInfo("lock-1")));
      expect(again.status).toBe(200);
    }
  });

  it("only takes a write from the holder of the lock", async () => {
    const store = new MemoryStateStore();
    await call(store, WRITER, "LOCK", "", JSON.stringify(lockInfo("lock-1")));

    const unnamed = await call(store, WRITER, "POST", "", state(1));
    expect(unnamed.status).toBe(423);
    expect(await unnamed.json()).toEqual(lockInfo("lock-1"));
    expect((await call(store, WRITER, "POST", "?ID=lock-2", state(1))).status).toBe(423);
    expect((await call(store, WRITER, "POST", "?ID=lock-1", state(1))).status).toBe(200);
    // Reading never needs the lock.
    expect((await call(store, READER, "GET")).status).toBe(200);

    await call(store, WRITER, "UNLOCK", "", JSON.stringify(lockInfo("lock-1")));
    // The lock a write names is gone: it was force-unlocked under the run.
    expect((await call(store, WRITER, "POST", "?ID=lock-1", state(2))).status).toBe(409);
    // No lock held and none named: `-lock=false`.
    expect((await call(store, WRITER, "POST", "", state(2))).status).toBe(200);
  });

  it("unlocks with UNLOCK, DELETE lock or POST unlock, by id", async () => {
    for (const [method, path] of [
      ["UNLOCK", ""],
      ["DELETE", "/lock"],
      ["POST", "/unlock"],
      ["UNLOCK", "/unlock"],
    ] as const) {
      const store = new MemoryStateStore();
      await call(store, WRITER, "LOCK", "", JSON.stringify(lockInfo("lock-1")));
      const wrong = await call(store, WRITER, method, path, JSON.stringify(lockInfo("lock-2")));
      expect(wrong.status).toBe(409);
      expect(await wrong.json()).toEqual(lockInfo("lock-1"));
      // `terraform force-unlock <id>` sends only the id.
      const right = await call(store, WRITER, method, path, JSON.stringify({ ID: "lock-1" }));
      expect(right.status).toBe(200);
      expect((await store.head()).lock).toBeNull();
      // Unlocking what is not locked is not an error.
      expect(
        (await call(store, WRITER, method, path, JSON.stringify({ ID: "lock-1" }))).status,
      ).toBe(200);
    }
  });

  it("lets only an admin unlock without naming the lock", async () => {
    const store = new MemoryStateStore();
    await call(store, WRITER, "LOCK", "", JSON.stringify(lockInfo("lock-1")));
    expect((await call(store, WRITER, "UNLOCK")).status).toBe(403);
    expect((await store.head()).lock?.info.ID).toBe("lock-1");
    expect((await call(store, ADMIN, "UNLOCK")).status).toBe(200);
    expect((await store.head()).lock).toBeNull();
  });

  it("keeps people who may not write from locking, writing and deleting", async () => {
    const store = new MemoryStateStore();
    expect((await call(store, READER, "LOCK", "", JSON.stringify(lockInfo("l")))).status).toBe(403);
    expect((await call(store, READER, "POST", "", state(1))).status).toBe(403);
    expect((await call(store, READER, "UNLOCK")).status).toBe(403);
    expect((await call(store, WRITER, "DELETE")).status).toBe(403);
  });

  it("lets a plan's credential lock and read, and write nothing", async () => {
    const store = new MemoryStateStore();
    const planner: StateAuth = { ...READER, principal: "ci:plan", canLock: true };
    expect((await call(store, WRITER, "POST", "", state(1))).status).toBe(200);
    const info = JSON.stringify(lockInfo("plan-lock"));
    expect((await call(store, planner, "LOCK", "", info)).status).toBe(200);
    expect((await call(store, planner, "GET")).status).toBe(200);
    expect((await call(store, planner, "POST", "?ID=plan-lock", state(2))).status).toBe(403);
    expect((await call(store, planner, "DELETE")).status).toBe(403);
    // Its own lock by id, never someone else's by force.
    expect((await call(store, planner, "UNLOCK")).status).toBe(403);
    expect((await call(store, planner, "UNLOCK", "", info)).status).toBe(200);
    expect((await store.head()).version?.serial).toBe(1);
  });

  it("deletes the current state but keeps its versions", async () => {
    const store = new MemoryStateStore();
    await call(store, WRITER, "POST", "", state(1));
    await call(store, WRITER, "LOCK", "", JSON.stringify(lockInfo("lock-1")));
    expect((await call(store, ADMIN, "DELETE")).status).toBe(423);
    await call(store, ADMIN, "UNLOCK");
    expect((await call(store, ADMIN, "DELETE")).status).toBe(200);
    expect((await call(store, READER, "GET")).status).toBe(404);
    expect(await store.versions({ limit: 10 })).toHaveLength(1);
    // With no current state, another lineage may start.
    expect((await call(store, WRITER, "POST", "", state(1, "lineage-b"))).status).toBe(200);
  });

  it("answers 405 with what the address does serve", async () => {
    const store = new MemoryStateStore();
    const patch = await call(store, WRITER, "PATCH");
    expect(patch.status).toBe(405);
    expect(patch.headers.get("allow")).toContain("LOCK");
    expect((await call(store, WRITER, "GET", "/lock")).status).toBe(405);
    expect((await call(store, WRITER, "LOCK", "/unlock", "{}")).status).toBe(405);
  });

  it("tells the host about each new version, and only new ones", async () => {
    const store = new MemoryStateStore();
    const seen: number[] = [];
    const post = (serial: number) =>
      handleStateRequest(
        new Request(STATE_URL, { method: "POST", body: state(serial) }),
        store,
        WRITER,
        {
          onVersion: (version) => void seen.push(version.serial),
        },
      );
    await post(1);
    await post(1);
    await post(2);
    expect(seen).toEqual([1, 2]);
  });
});

describe("restoring a version", () => {
  it("writes the old document again as the newest, byte for byte but the serial", async () => {
    const store = new MemoryStateStore();
    // An integer JSON.parse would round: it has to survive the restore.
    const first = state(1).replace('"outputs": {}', '"outputs": {"big": 9007199254740993}');
    await call(store, WRITER, "POST", "", first);
    await call(store, WRITER, "POST", "", state(2));
    const [, oldest] = await store.versions({ limit: 10 });

    const outcome = await restoreVersion(store, oldest!.id, { actor: "user:a" });
    expect(outcome.kind).toBe("restored");
    const current = await (await call(store, READER, "GET")).text();
    expect(current).toBe(first.replace('"serial": 1', '"serial": 3'));
    expect(current).toContain("9007199254740993");
    expect((await store.versions({ limit: 10 })).map((v) => v.serial)).toEqual([3, 2, 1]);
  });

  it("is refused while the state is locked, and for a version that is not there", async () => {
    const store = new MemoryStateStore();
    await call(store, WRITER, "POST", "", state(1));
    const [version] = await store.versions({ limit: 1 });
    await call(store, WRITER, "LOCK", "", JSON.stringify(lockInfo("lock-1")));
    expect((await restoreVersion(store, version!.id, { actor: "user:a" })).kind).toBe("locked");
    expect((await unlockState(store, { lockId: null, force: true })).kind).toBe("released");
    expect((await restoreVersion(store, "nope", { actor: "user:a" })).kind).toBe("not-found");
  });

  it("only rewrites the top-level serial", () => {
    const text = '{"a": {"serial": 7}, "s": "serial", "serial" : 12, "resources": [{"serial": 1}]}';
    expect(withSerial(text, 40)).toBe(
      '{"a": {"serial": 7}, "s": "serial", "serial" : 40, "resources": [{"serial": 1}]}',
    );
    expect(withSerial('{"x": "\\"serial\\": 1"}', 2)).toBeNull();
    // A serial is replaced whole, however JSON spelled it.
    expect(withSerial('{"serial": 1e3, "lineage": "l"}', 1001)).toBe(
      '{"serial": 1001, "lineage": "l"}',
    );
    expect(withSerial('{"serial":12.0E+1}', 121)).toBe('{"serial":121}');
    expect(withSerial('{"serial": "12"}', 13)).toBeNull();
  });
});

describe("paging versions", () => {
  it("lists newest first, a page at a time", async () => {
    const store = new MemoryStateStore();
    for (let serial = 1; serial <= 5; serial++)
      await call(store, WRITER, "POST", "", state(serial));
    const first = await store.versions({ limit: 2 });
    expect(first.map((v) => v.serial)).toEqual([5, 4]);
    const second = await store.versions({ limit: 2, before: first[1]!.id });
    expect(second.map((v) => v.serial)).toEqual([3, 2]);
  });
});
