/**
 * JavaScript source injected into the sandbox before the user's workflow runs.
 * It builds `globalThis.infra` from two host-provided globals:
 *
 *   - `__host(method, argsJson)` — async RPC into the host (returns a JSON string)
 *   - `__accountsTree` — JSON string of WorkflowPluginInfo[] (accounts by plugin)
 *   - `__metrics` — JSON string of the declared metrics' current values
 *
 * Keeping the ergonomic object graph in pure JS here (rather than marshalling a
 * deep object across the WASM boundary) makes the bridge robust and trivially
 * typeable — the generated infra.d.ts mirrors exactly the shape built below.
 */
export const PRELUDE = String.raw`
(() => {
  const rpc = async (method, args) => {
    const raw = await __host(method, JSON.stringify(args || {}));
    return raw === undefined || raw === null || raw === "" ? undefined : JSON.parse(raw);
  };

  // Object-read ops bound to one bucket, mixed onto a storage-capable
  // resource so e.g. (await cf.getR2Bucket("configs")).get("app.json") works.
  const bucketOf = (r) =>
    (r && (r.externalId || (r.id ? String(r.id).split(":").pop() : ""))) || "";
  const makeStorageOps = (accountId, bucket) => ({
    list: (prefix) => rpc("storage.list", { accountId, bucket, prefix: prefix || "" }),
    get: async (key) => {
      const body = await rpc("storage.get", { accountId, bucket, key });
      return {
        base64: body.base64,
        text: () => body.text,
        json: () => JSON.parse(body.text),
      };
    },
  });

  const makeResourceHandle = (accountId, typeId) => ({
    list: () => rpc("resource.list", { accountId, typeId }),
    get: (externalId) => rpc("resource.get", { accountId, typeId, externalId }),
    create: (fields, parentResourceId) =>
      rpc("resource.create", { accountId, typeId, fields: fields || {}, parentResourceId }),
    update: (resourceId, fields) =>
      rpc("resource.update", { accountId, typeId, resourceId, fields: fields || {} }),
    delete: (resourceId) => rpc("resource.delete", { accountId, typeId, resourceId }),
  });

  // PascalCase, preserving internal casing — MUST match codegen's pascalCase so
  // the per-type method names built here line up with the generated typings.
  const pascal = (s) =>
    s
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");

  const makeAccountHandle = (acc, resourceTypes) => {
    const handle = {
      id: acc.id,
      pluginId: acc.pluginId,
      displayName: acc.displayName,
      resolveOutput: (typeId, resourceId, outputKey) =>
        rpc("resource.resolveOutput", { accountId: acc.id, typeId, resourceId, outputKey }),
    };
    for (const rt of resourceTypes) {
      const h = makeResourceHandle(acc.id, rt.id);
      const s = pascal(rt.displayName);
      const p = pascal(rt.pluralDisplayName);
      // Storage-capable types return resources augmented with bucket-read ops.
      const wrap = rt.storage
        ? (r) => (r ? Object.assign({}, r, makeStorageOps(acc.id, bucketOf(r))) : r)
        : (r) => r;
      if (!("list" + p in handle))
        handle["list" + p] = async () => (await h.list()).map(wrap);
      if (!("get" + s in handle)) handle["get" + s] = async (externalId) => wrap(await h.get(externalId));
      if (rt.supportsCreate && !("create" + s in handle))
        handle["create" + s] = async (fields, parentResourceId) =>
          wrap(await h.create(fields, parentResourceId));
      if (rt.supportsUpdate && !("update" + s in handle))
        handle["update" + s] = async (resourceId, fields) => wrap(await h.update(resourceId, fields));
      if (rt.supportsDelete && !("delete" + s in handle))
        handle["delete" + s] = (resourceId) => h.delete(resourceId);
    }
    return handle;
  };

  const tree = JSON.parse(__accountsTree);
  const accounts = {};
  for (const p of tree) {
    const list = p.accounts;
    const rts = p.resourceTypes;
    const make = (acc) => makeAccountHandle(acc, rts);
    accounts[p.pluginId] = {
      list: () => list.map(make),
      getById: (id) => {
        const a = list.find((x) => x.id === id);
        if (!a) throw new Error("No " + p.pluginId + " account with id " + id);
        return make(a);
      },
      getByName: (name) => {
        const a = list.find((x) => x.displayName === name);
        if (!a) throw new Error("No " + p.pluginId + " account named " + name);
        return make(a);
      },
    };
  }

  const log = (level) => (...parts) =>
    rpc("log", { level, message: parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") });

  // Metrics are exposed as direct typed properties (infra.metrics.<key>): reads
  // come from a snapshot taken at run start; writes update the snapshot and are
  // buffered, then persisted once (final value per key) after the run via
  // globalThis.__flushMetrics (see sandbox buildProgram). Property setters can't
  // be async, hence the deferred flush.
  const metricState = (() => { try { return JSON.parse(__metrics || "{}"); } catch (e) { return {}; } })();
  const metricDirty = new Set();
  const metrics = new Proxy(metricState, {
    get: (t, k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : (typeof k === "string" ? null : undefined)),
    set: (t, k, v) => {
      if (typeof k !== "string") return false;
      t[k] = v;
      metricDirty.add(k);
      return true;
    },
  });
  globalThis.__flushMetrics = async () => {
    for (const k of metricDirty) {
      await rpc("metric.set", { key: k, value: metricState[k] });
    }
    metricDirty.clear();
  };

  globalThis.infra = {
    accounts,
    prompt: (spec) => rpc("prompt", { spec: typeof spec === "string" ? { message: spec } : spec }),
    metrics,
    output: (value) => rpc("output", { value }),
    log: log("info"),
  };

  // Route console.* to the run log as well.
  const c = (level) => (...parts) =>
    rpc("log", { level, message: parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") });
  globalThis.console = { log: c("info"), info: c("info"), warn: c("warn"), error: c("error"), debug: c("debug") };
})();
`;
