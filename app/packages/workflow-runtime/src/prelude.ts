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

  const makeStorage = (accountId) => ({
    bucket: (bucket) => ({
      list: (prefix) => rpc("storage.list", { accountId, bucket, prefix: prefix || "" }),
      get: async (key) => {
        const body = await rpc("storage.get", { accountId, bucket, key });
        return {
          base64: body.base64,
          text: () => body.text,
          json: () => JSON.parse(body.text),
        };
      },
    }),
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

  const makeAccountHandle = (acc, resourceTypes) => {
    const resources = {};
    for (const rt of resourceTypes) {
      resources[rt.id] = makeResourceHandle(acc.id, rt.id);
    }
    return {
      id: acc.id,
      pluginId: acc.pluginId,
      displayName: acc.displayName,
      resources,
      resolveOutput: (typeId, resourceId, outputKey) =>
        rpc("resource.resolveOutput", { accountId: acc.id, typeId, resourceId, outputKey }),
      storage: makeStorage(acc.id),
      call: (method, args) => rpc(method, Object.assign({ accountId: acc.id }, args || {})),
    };
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
