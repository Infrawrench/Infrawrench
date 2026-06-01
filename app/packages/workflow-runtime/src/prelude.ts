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

  // Minimal base64 → Uint8Array decode (QuickJS has no guaranteed atob).
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64 = (s) => {
    if (!s) return new Uint8Array(0);
    const lookup = b64.lookup || (b64.lookup = (() => {
      const t = new Uint8Array(256);
      for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
      return t;
    })());
    let len = s.length;
    while (len > 0 && s[len - 1] === "=") len--;
    const out = new Uint8Array((len * 3) >> 2);
    let bits = 0, acc = 0, p = 0;
    for (let i = 0; i < len; i++) {
      acc = (acc << 6) | lookup[s.charCodeAt(i)];
      bits += 6;
      if (bits >= 8) { bits -= 8; out[p++] = (acc >> bits) & 0xff; }
    }
    return out;
  };
  // Minimal UTF-8 decode (avoid assuming TextDecoder).
  const utf8 = (bytes) => {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let out = "";
    for (let i = 0; i < bytes.length;) {
      const c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else if (c < 0xf0)
        out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      else {
        const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        const u = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      }
    }
    return out;
  };

  // SSH ops mixed onto every resource: a single combined ssh(command, opts)
  // that resolves the full output (string, or Uint8Array when encoding:"binary")
  // or — when opts.stream is set — returns an async-iterable of stdout chunks.
  const makeSshOps = (accountId, typeId, resourceId, defaultSshKey) => {
    const baseFor = (command, opts) => ({
      accountId, typeId, resourceId, command,
      // Fall back to the key attached at create time (if any) so a freshly
      // created resource can ssh() without re-specifying the key.
      sshKeyId: opts.sshKey || defaultSshKey,
      username: opts.username, timeoutMs: opts.timeoutMs,
      skipHostKeyCheck: opts.skipHostKeyCheck,
    });
    const ssh = (command, opts) => {
      opts = opts || {};
      if (opts.stream) {
        return {
          [Symbol.asyncIterator]() {
            let streamId = null;
            let started = null;
            const ensure = async () => {
              if (!started) started = rpc("ssh.streamStart", baseFor(command, opts)).then((r) => { streamId = r.streamId; });
              await started;
            };
            return {
              async next() {
                await ensure();
                const chunk = await rpc("ssh.streamRead", { streamId });
                if (chunk && chunk.done) {
                  if (typeof chunk.code === "number" && chunk.code !== 0)
                    throw new Error("ssh stream exited with code " + chunk.code);
                  return { value: undefined, done: true };
                }
                const bytes = b64(chunk && chunk.dataBase64);
                return { value: opts.encoding === "utf8" ? utf8(bytes) : bytes, done: false };
              },
              async return(value) {
                if (streamId) { try { await rpc("ssh.streamClose", { streamId }); } catch (e) {} }
                return { value, done: true };
              },
            };
          },
        };
      }
      return rpc("ssh.exec", baseFor(command, opts)).then((r) => {
        if (r.code !== 0) throw new Error("ssh command exited with code " + r.code + ": " + utf8(b64(r.stderrBase64)));
        const bytes = b64(r.stdoutBase64);
        return opts.encoding === "binary" ? bytes : utf8(bytes);
      });
    };
    const waitUntilReachable = (opts) => {
      opts = opts || {};
      return rpc("ssh.probe", { accountId, typeId, resourceId, port: opts.port, timeoutMs: opts.timeoutMs }).then((ok) => {
        if (!ok) throw new Error("Resource did not become SSH-reachable in time");
      });
    };
    return { ssh, waitUntilReachable };
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

  // camelCase: first word fully lowercased (leading acronyms read naturally:
  // "DNS Records" → "dnsRecords"), following words capitalized. MUST match
  // codegen's camelCase so group names line up with the generated typings.
  const camel = (s) => {
    const words = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (words.length === 0) return "";
    const tail = words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
    return words[0].toLowerCase() + tail;
  };

  const makeAccountHandle = (acc, resourceTypes) => {
    const handle = {
      id: acc.id,
      pluginId: acc.pluginId,
      displayName: acc.displayName,
      resolveOutput: (typeId, resourceId, outputKey) =>
        rpc("resource.resolveOutput", { accountId: acc.id, typeId, resourceId, outputKey }),
    };
    for (const rt of resourceTypes) {
      const group = camel(rt.pluralDisplayName);
      if (!group || group in handle) continue;
      const h = makeResourceHandle(acc.id, rt.id);
      // Every resource gets ssh()/waitUntilReachable(); storage-capable types
      // additionally get bucket-read ops. The resource's canonical id (r.id) is
      // what the host resolves outputs (e.g. the SSH host) against.
      const wrap = (r) => {
        if (!r) return r;
        const augmented = Object.assign({}, r, makeSshOps(acc.id, rt.id, r.id, r.sshKeyRef), {
          // Delete this very resource (by its own id). The host rejects if the
          // owning plugin doesn't support deletion.
          delete: () => h.delete(r.id),
        });
        if (rt.storage) Object.assign(augmented, makeStorageOps(acc.id, bucketOf(r)));
        return augmented;
      };
      const g = {
        list: async () => (await h.list()).map(wrap),
        get: async (externalId) => wrap(await h.get(externalId)),
      };
      if (rt.supportsCreate)
        g.create = async (fields, parentResourceId) => wrap(await h.create(fields, parentResourceId));
      if (rt.supportsUpdate)
        g.update = async (resourceId, fields) => wrap(await h.update(resourceId, fields));
      if (rt.supportsDelete) g.delete = (resourceId) => h.delete(resourceId);
      handle[group] = g;
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
