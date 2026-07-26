/**
 * JavaScript source injected into the sandbox before the user's workflow runs.
 * It builds `globalThis.infra` from two host-provided globals:
 *
 *   - `__host(method, argsJson)` — async RPC into the host (returns a JSON string)
 *   - `__accountsTree` — JSON string of WorkflowPluginInfo[] (accounts by plugin)
 *   - `__metrics` — JSON string of the declared metrics' current values
 *   - `__event` — JSON string describing what triggered this run
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

  // Format one log argument: strings pass through, byte buffers (Uint8Array,
  // any TypedArray/DataView, or a raw ArrayBuffer) are decoded as UTF-8 text so
  // that e.g. infra.log(await r.sftp.get(path)) prints the file, not {"0":104,…}.
  const fmtPart = (p) => {
    if (typeof p === "string") return p;
    if (p instanceof Uint8Array) return utf8(p);
    if (typeof ArrayBuffer !== "undefined") {
      if (p instanceof ArrayBuffer) return utf8(new Uint8Array(p));
      if (ArrayBuffer.isView(p)) return utf8(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    }
    return JSON.stringify(p);
  };
  const fmtParts = (parts) => parts.map(fmtPart).join(" ");

  // Minimal Uint8Array → base64 encode (QuickJS has no guaranteed btoa).
  const b64enc = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
      out += i + 2 < bytes.length ? B64[c & 63] : "=";
    }
    return out;
  };
  // Coerce a workflow value (string | Uint8Array) into bytes for upload.
  const toBytes = (data) => {
    if (typeof data !== "string") return data;
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(data);
    const out = [];
    for (let i = 0; i < data.length; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (data.charCodeAt(++i) & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  };

  // A streaming SSH command, demuxed into separate stdout/stderr readables.
  // The returned object: { stdout, stderr } each async-iterable (+ getReader()),
  // and is itself async-iterable over stdout (back-compat). A single host poll
  // returns whatever stdout/stderr accumulated; a shared pump distributes it.
  const makeSshStreams = (base) => {
    let streamId = null;
    let started = null;
    let done = false;
    let pumping = null;
    const outQ = [];
    const errQ = [];
    const ensure = async () => {
      if (!started) started = rpc("ssh.streamStart", base).then((r) => { streamId = r.streamId; });
      await started;
    };
    const pump = async () => {
      await ensure();
      const chunk = await rpc("ssh.streamRead", { streamId });
      if (!chunk) { done = true; return; }
      if (chunk.stdoutBase64) outQ.push(b64(chunk.stdoutBase64));
      if (chunk.stderrBase64) errQ.push(b64(chunk.stderrBase64));
      if (chunk.done) done = true;
    };
    const pumpOnce = () => {
      if (!pumping) pumping = pump().then(() => { pumping = null; }, (e) => { pumping = null; done = true; throw e; });
      return pumping;
    };
    const close = async () => { if (streamId) { try { await rpc("ssh.streamClose", { streamId }); } catch (e) {} } };
    const reader = (queue) => ({
      async next() {
        while (queue.length === 0 && !done) await pumpOnce();
        if (queue.length > 0) return { value: queue.shift(), done: false };
        return { value: undefined, done: true };
      },
      async return(value) { await close(); return { value, done: true }; },
    });
    const channel = (queue) => ({
      [Symbol.asyncIterator]: () => reader(queue),
      getReader() {
        const it = reader(queue);
        return { read: () => it.next(), releaseLock() {}, cancel: () => close() };
      },
    });
    return {
      __sshStream: true,
      stdout: channel(outQ),
      stderr: channel(errQ),
      [Symbol.asyncIterator]: () => reader(outQ),
    };
  };

  // SSH ops mixed onto every resource: a single combined ssh(command, opts)
  // that resolves the full output (string, or Uint8Array when encoding:"binary")
  // or — when opts.stream is set — returns an { stdout, stderr } streams object.
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
      if (opts.stream) return makeSshStreams(baseFor(command, opts));
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
    // SFTP file operations over the same SSH config (key defaults to the one
    // attached at create time). list/get/put/mkdir/delete.
    const sftpBase = (opts) => {
      opts = opts || {};
      return { accountId, typeId, resourceId, sshKeyId: opts.sshKey || defaultSshKey, username: opts.username };
    };
    const sftp = {
      list: (path, opts) => rpc("sftp.list", Object.assign(sftpBase(opts), { path: path || "." })),
      get: (path, opts) =>
        rpc("sftp.get", Object.assign(sftpBase(opts), { path })).then((r) =>
          opts && opts.encoding === "utf8" ? utf8(b64(r.base64)) : b64(r.base64),
        ),
      put: (path, data, opts) => rpc("sftp.put", Object.assign(sftpBase(opts), { path, base64: b64enc(toBytes(data)) })),
      mkdir: (path, opts) => rpc("sftp.mkdir", Object.assign(sftpBase(opts), { path })),
      delete: (path, opts) => rpc("sftp.delete", Object.assign(sftpBase(opts), { path, isDir: !!(opts && opts.recursive) })),
    };
    return { ssh, waitUntilReachable, sftp };
  };

  // Extended per-resource capabilities (plugin-client passthroughs): SQL query,
  // KV browser, NoSQL commands, k8s logs/describe, manifest, pub/sub, metrics.
  // Each throws a clear error at runtime if the owning plugin doesn't support it.
  const makeResourceCaps = (accountId, typeId, resourceId) => ({
    query: (sql) => rpc("resource.query", { accountId, resourceId, sql }),
    kv: {
      list: (params) => rpc("kv.list", { accountId, typeId, resourceId, params: params || {} }),
      get: (key) => rpc("kv.get", { accountId, typeId, resourceId, key }),
      set: (key, value) => rpc("kv.put", { accountId, typeId, resourceId, key, value: typeof value === "string" ? value : JSON.stringify(value) }),
      delete: (key) => rpc("kv.delete", { accountId, typeId, resourceId, key }),
    },
    nosql: (command, args) => rpc("resource.nosql", { accountId, typeId, resourceId, command, args: args || [] }),
    logs: (params) => rpc("resource.logs", { accountId, typeId, resourceId, params: params || {} }),
    describe: () => rpc("resource.describe", { accountId, typeId, resourceId }),
    getManifest: () => rpc("resource.getManifest", { accountId, resourceId }),
    applyManifest: (manifest) => rpc("resource.applyManifest", { accountId, resourceId, manifest }),
    publish: (payload) => rpc("resource.publish", { accountId, typeId, resourceId, payload: typeof payload === "string" ? { body: payload } : payload }),
    metrics: (timeRange) => rpc("resource.metrics", { accountId, typeId, resourceId, timeRange }),
  });

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
      // Apply arbitrary (multi-document) YAML to this account (kubectl apply -f).
      importYaml: (yaml) => rpc("account.importYaml", { accountId: acc.id, yaml }),
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
        const augmented = Object.assign(
          {},
          r,
          makeSshOps(acc.id, rt.id, r.id, r.sshKeyRef),
          makeResourceCaps(acc.id, rt.id, r.id),
          {
            // Delete this very resource (by its own id). The host rejects if the
            // owning plugin doesn't support deletion.
            delete: () => h.delete(r.id),
          },
        );
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

  const log = (level) => (...parts) => rpc("log", { level, message: fmtParts(parts) });

  // Stream an SSH streams object to the run log line-by-line: stdout at "info"
  // and stderr at "error" (rendered red), as output arrives.
  const streamToLog = async (streams) => {
    const drain = async (readable, level) => {
      let buf = "";
      for await (const chunk of readable) {
        buf += typeof chunk === "string" ? chunk : utf8(chunk);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          await rpc("log", { level, message: buf.slice(0, nl) });
          buf = buf.slice(nl + 1);
        }
      }
      if (buf.length) await rpc("log", { level, message: buf });
    };
    await Promise.all([drain(streams.stdout, "info"), drain(streams.stderr, "error")]);
  };

  // infra.log: awaits any promise arguments first (so you can pass an unawaited
  // ssh()/sftp.get() call straight in), then — if handed an SSH streams object —
  // streams it; otherwise logs a line. Byte buffers are decoded as UTF-8.
  const infraLog = async (...parts) => {
    const resolved = await Promise.all(parts);
    if (resolved.length === 1 && resolved[0] && resolved[0].__sshStream) return streamToLog(resolved[0]);
    return rpc("log", { level: "info", message: fmtParts(resolved) });
  };

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

  // What kicked off this run. Frozen: it describes the past, and a workflow
  // mutating it would only confuse a later read of the same object.
  const event = Object.freeze((() => {
    try { return JSON.parse(__event || '{"kind":"manual"}'); } catch (e) { return { kind: "manual" }; }
  })());

  // Report spend from a source Infrawrench has no plugin for. Accepts one row
  // or an array so a single-row write reads naturally; chunked so a workflow
  // backfilling a year doesn't build one enormous RPC payload.
  const COST_CHUNK = 1000;
  const costs = {
    write: async (rows) => {
      const all = Array.isArray(rows) ? rows : [rows];
      let written = 0;
      for (let i = 0; i < all.length; i += COST_CHUNK) {
        const res = await rpc("costs.write", { rows: all.slice(i, i + COST_CHUNK) });
        written += (res && res.written) || 0;
      }
      return { written };
    },
  };

  // Raise an alert to whoever owns this workflow. Accepts either
  // page("text", opts) or page({ message, ... }) so the common case stays one
  // argument. Throttling lives host-side (keyed, so it holds across runs).
  const page = (messageOrSpec, opts) => {
    const spec = typeof messageOrSpec === "string"
      ? Object.assign({}, opts || {}, { message: messageOrSpec })
      : (messageOrSpec || {});
    return rpc("page", { spec });
  };
  // Re-arm a key after the condition it alerted on recovered, so the next
  // occurrence pages immediately instead of waiting out a stale cooldown.
  page.clear = (key) => rpc("page.clear", { key });

  globalThis.infra = {
    accounts,
    prompt: (spec) => rpc("prompt", { spec: typeof spec === "string" ? { message: spec } : spec }),
    metrics,
    event,
    costs,
    page,
    output: (value) => rpc("output", { value }),
    log: infraLog,
  };

  // Route console.* to the run log as well.
  const c = (level) => (...parts) => rpc("log", { level, message: fmtParts(parts) });
  globalThis.console = { log: c("info"), info: c("info"), warn: c("warn"), error: c("error"), debug: c("debug") };
})();
`;
