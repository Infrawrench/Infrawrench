//! wasm-bindgen backed implementation of the private `snapi_bridge_*` ABI.
//!
//! The guest marshalling layer intentionally remains shared with the native
//! V8 backend. This module owns JavaScript values in the embedding realm and
//! publishes the C symbols that layer already calls.

#![allow(clippy::missing_safety_doc)]

use std::{
    cell::{Cell, RefCell, UnsafeCell},
    collections::{HashMap, VecDeque},
    ffi::{CStr, CString, c_void},
    ptr,
    rc::Rc,
    slice,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use js_sys::{
    Array, ArrayBuffer, Date, Error, Function, Object, Promise, Reflect, SharedArrayBuffer,
    TypeError, Uint8Array, WeakMap, WeakRef,
};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;

use crate::snapi::{
    SnapiEnv, SnapiEnvState, SnapiUnofficialHeapCodeStatistics, SnapiUnofficialHeapSpaceStatistics,
    SnapiUnofficialHeapStatistics,
};

const NAPI_OK: i32 = 0;
const NAPI_INVALID_ARG: i32 = 1;
const NAPI_OBJECT_EXPECTED: i32 = 2;
const NAPI_STRING_EXPECTED: i32 = 3;
const NAPI_FUNCTION_EXPECTED: i32 = 5;
const NAPI_ARRAY_EXPECTED: i32 = 8;
const NAPI_GENERIC_FAILURE: i32 = 9;
const NAPI_PENDING_EXCEPTION: i32 = 10;
const JS_BACKING_TOKEN_MARKER: u64 = 1 << 63;
const CALLBACK_DEFERRED: u32 = u32::MAX;

const SERIALIZED_MESSAGE_SEQUENCE_BITS: u32 = 20;
const SERIALIZED_MESSAGE_SEQUENCE_MASK: u32 = (1 << SERIALIZED_MESSAGE_SEQUENCE_BITS) - 1;
const SERIALIZED_MESSAGE_SCOPE_MAX: u32 = (1 << (32 - SERIALIZED_MESSAGE_SEQUENCE_BITS)) - 1;

static NEXT_SERIALIZED_MESSAGE_SEQUENCE: AtomicU32 = AtomicU32::new(1);
// Runtime flags configure the provider, not an individual N-API environment
// or calling thread. Worker environments are created on guest pthreads, so a
// thread-local configuration would incorrectly make the process-global setup
// performed by the main thread invisible there.
static RUNTIME_ENGINE_FLAGS: Mutex<Option<Vec<u8>>> = Mutex::new(None);

fn next_serialized_message(scope: u32) -> Option<u32> {
    if scope > SERIALIZED_MESSAGE_SCOPE_MAX {
        return None;
    }
    let sequence = NEXT_SERIALIZED_MESSAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    if sequence == 0 || sequence > SERIALIZED_MESSAGE_SEQUENCE_MASK {
        return None;
    }
    Some((scope << SERIALIZED_MESSAGE_SEQUENCE_BITS) | sequence)
}

#[wasm_bindgen(inline_js = r#"
import { parse as wasmerNapiParse } from 'acorn';

export function wasmer_napi_make_callback(dispatch) {
  return function (...args) {
    return dispatch(this, args);
  };
}
export function wasmer_napi_has_jspi() {
  return typeof WebAssembly.Suspending === 'function' &&
         typeof WebAssembly.promising === 'function';
}
export function wasmer_napi_instanceof(value, ctor) {
  return value instanceof ctor;
}
export function wasmer_napi_new(ctor, args) {
  return Reflect.construct(ctor, args);
}
export function wasmer_napi_symbol(description) {
  return Symbol(description);
}
export function wasmer_napi_string(value) {
  return String(value);
}
export function wasmer_napi_number(value) {
  return Number(value);
}
export function wasmer_napi_console_error(message) {
  console.error(message);
}
let wasmerNapiActiveGlobalContext;
const wasmerNapiBuffers = new WeakSet();
const wasmerNapiHostSetTimeout = globalThis.setTimeout.bind(globalThis);
const wasmerNapiHostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const wasmerNapiHostPromise = globalThis.Promise;
const wasmerNapiHostPromiseThen = globalThis.Promise.prototype.then;
let wasmerNapiPendingProviderWork = 0;
let wasmerNapiSettledProviderWork = false;
function wasmerNapiTrackHostPromise(value) {
  wasmerNapiPendingProviderWork += 1;
  const promise = wasmerNapiHostPromise.resolve(value);
  return wasmerNapiHostPromiseThen.call(
    promise,
    (result) => {
      wasmerNapiPendingProviderWork -= 1;
      wasmerNapiSettledProviderWork = true;
      return result;
    },
    (error) => {
      wasmerNapiPendingProviderWork -= 1;
      wasmerNapiSettledProviderWork = true;
      throw error;
    },
  );
}
export function wasmer_napi_has_pending_provider_work() {
  if (wasmerNapiPendingProviderWork !== 0) return true;
  if (!wasmerNapiSettledProviderWork) return false;
  wasmerNapiSettledProviderWork = false;
  return true;
}
const wasmerNapiYieldChannel = typeof globalThis.MessageChannel === 'function'
  ? new globalThis.MessageChannel()
  : undefined;
const wasmerNapiYieldResolvers = [];
const wasmerNapiMaxConsecutiveFastYields = 32;
let wasmerNapiConsecutiveFastYields = 0;
if (wasmerNapiYieldChannel !== undefined) {
  wasmerNapiYieldChannel.port1.onmessage = () => {
    const resolve = wasmerNapiYieldResolvers.shift();
    if (resolve !== undefined) resolve();
    if (wasmerNapiYieldResolvers.length === 0 &&
        typeof wasmerNapiYieldChannel.port1.unref === 'function') {
      wasmerNapiYieldChannel.port1.unref();
      wasmerNapiYieldChannel.port2.unref();
    }
  };
  if (typeof wasmerNapiYieldChannel.port1.start === 'function') {
    wasmerNapiYieldChannel.port1.start();
  }
  if (typeof wasmerNapiYieldChannel.port1.unref === 'function') {
    wasmerNapiYieldChannel.port1.unref();
    wasmerNapiYieldChannel.port2.unref();
  }
}
const wasmerNapiPromiseDetails = new WeakMap();
export function wasmer_napi_event_loop_checkpoint(allowHostTasks, hasRunnableWork) {
  // A Node microtask checkpoint must not admit timers, I/O, or messages. JSPI
  // still needs one suspension so the host engine can drain its Promise queue.
  if (!allowHostTasks) {
    return new wasmerNapiHostPromise((resolve) => {
      wasmerNapiHostQueueMicrotask(resolve);
    });
  }
  // Runnable libuv work only needs a host task boundary; MessageChannel
  // provides one without imposing a timer delay on every turn. Bound each
  // burst so a continuously-ready or stale native handle cannot monopolize
  // the host task queue; the timer turn is the scheduler fairness boundary.
  // Idle loops always use the timer path. Both primitives are captured from
  // the host realm and cannot be replaced by Node's guest global.
  const canYieldFast = hasRunnableWork &&
    wasmerNapiYieldChannel !== undefined &&
    wasmerNapiConsecutiveFastYields < wasmerNapiMaxConsecutiveFastYields;
  if (canYieldFast) {
    wasmerNapiConsecutiveFastYields += 1;
    return new wasmerNapiHostPromise((resolve) => {
      if (wasmerNapiYieldResolvers.length === 0 &&
          typeof wasmerNapiYieldChannel.port1.ref === 'function') {
        wasmerNapiYieldChannel.port1.ref();
        wasmerNapiYieldChannel.port2.ref();
      }
      wasmerNapiYieldResolvers.push(resolve);
      wasmerNapiYieldChannel.port2.postMessage(0);
    });
  }
  wasmerNapiConsecutiveFastYields = 0;
  return new wasmerNapiHostPromise((resolve) => wasmerNapiHostSetTimeout(resolve, 1));
}
export function wasmer_napi_enqueue_microtask(callback) {
  wasmerNapiHostQueueMicrotask(callback);
}
export function wasmer_napi_get_promise_details(promise) {
  let details = wasmerNapiPromiseDetails.get(promise);
  if (details === undefined) {
    details = { state: 0, result: undefined, hasResult: false };
    wasmerNapiPromiseDetails.set(promise, details);
    wasmerNapiHostPromiseThen.call(
      promise,
      (value) => {
        details.state = 1;
        details.result = value;
        details.hasResult = true;
      },
      (error) => {
        details.state = 2;
        details.result = error;
        details.hasResult = true;
      },
    );
  }
  return [details.state, details.result, details.hasResult];
}
const wasmerNapiHostStructuredClone =
  typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone.bind(globalThis)
    : undefined;
const wasmerNapiHostCapiShare = globalThis.__wasmerCapiShare?.bind(globalThis);
const wasmerNapiHostCapiObtain = globalThis.__wasmerCapiObtain?.bind(globalThis);
const wasmerNapiHostCapiWait = globalThis.__wasmerCapiWait?.bind(globalThis);
const wasmerNapiHostCapiDelete = globalThis.__wasmerCapiDelete?.bind(globalThis);
const wasmerNapiHostCapiMessageScope = globalThis.__wasmerCapiMessageScope?.bind(globalThis);
const wasmerNapiMessageRegistryId = 0x4e415049;
// wasm-bindgen-futures and Wasmer's JSPI glue schedule the suspended guest
// through these host-realm primitives. Edge installs Node-compatible globals
// with the same names in its own scope; mirroring those values onto the worker
// global would make the host executor recursively enter the suspended guest.
const wasmerNapiHostSchedulingGlobals = new Set([
  'Atomics',
  'Promise',
  'SharedArrayBuffer',
  'WebAssembly',
  'queueMicrotask',
  'setTimeout',
]);
// Web global operations are specified with a realm receiver. Copying one onto
// Edge's virtual global and invoking it there would otherwise throw "Illegal
// invocation" in browsers. Constructors and ECMAScript intrinsics remain
// unbound so their prototypes and identity semantics stay intact.
const wasmerNapiHostGlobalBindings = new Map();
for (const key of [
  'addEventListener',
  'close',
  'dispatchEvent',
  'postMessage',
  'queueMicrotask',
  'removeEventListener',
  'setTimeout',
  'structuredClone',
]) {
  const value = globalThis[key];
  if (typeof value === 'function') {
    wasmerNapiHostGlobalBindings.set(key, {
      raw: value,
      bound: value.bind(globalThis),
    });
  }
}
function wasmerNapiSnapshotGlobal() {
  return Object.getOwnPropertyDescriptors(globalThis);
}
function wasmerNapiSyncGlobalScope(context, snapshot) {
  const target = context.scopeTarget;
  for (const key of Reflect.ownKeys(target)) {
    if (key === 'global' || key === 'globalThis') continue;
    // Host scheduling primitives intentionally stay local to each N-API
    // context. Edge replaces some of them (notably setTimeout and
    // queueMicrotask) with Node-compatible implementations, while the worker
    // global must retain the originals for JSPI and wasm-bindgen scheduling.
    if (wasmerNapiHostSchedulingGlobals.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      try { delete target[key]; } catch {}
    }
  }
  for (const key of Reflect.ownKeys(snapshot)) {
    if (key === 'global' || key === 'globalThis') continue;
    if (wasmerNapiHostSchedulingGlobals.has(key) &&
        Object.prototype.hasOwnProperty.call(target, key)) {
      continue;
    }
    try {
      const descriptor = snapshot[key];
      const targetDescriptor = {
        configurable: true,
        enumerable: descriptor.enumerable,
      };
      if ('value' in descriptor) {
        targetDescriptor.writable = true;
        const hostBinding = wasmerNapiHostGlobalBindings.get(key);
        targetDescriptor.value = hostBinding !== undefined && descriptor.value === hostBinding.raw
          ? hostBinding.bound
          : descriptor.value;
      } else {
        targetDescriptor.get = descriptor.get;
        targetDescriptor.set = descriptor.set;
      }
      Object.defineProperty(target, key, targetDescriptor);
    } catch {}
  }
  Object.defineProperties(target, {
    global: { configurable: true, writable: true, value: context.scope },
    globalThis: { configurable: true, writable: true, value: context.scope },
  });
  return context.scope;
}
export function wasmer_napi_create_global_context() {
  const context = {
    scopeTarget: Object.create(null),
  };
  context.scope = new Proxy(context.scopeTarget, {
    has(target, key) {
      if (key === 'global' || key === 'globalThis') return true;
      return Reflect.has(target, key) || Reflect.has(globalThis, key);
    },
    get(target, key, receiver) {
      if (key === 'global' || key === 'globalThis') return receiver;
      if (Reflect.has(target, key)) {
        const value = Reflect.get(target, key, receiver);
        const hostBinding = wasmerNapiHostGlobalBindings.get(key);
        return hostBinding !== undefined && value === hostBinding.raw
          ? hostBinding.bound
          : value;
      }
      const value = Reflect.get(globalThis, key, globalThis);
      const hostBinding = wasmerNapiHostGlobalBindings.get(key);
      return hostBinding !== undefined && value === hostBinding.raw
        ? hostBinding.bound
        : value;
    },
    set(target, key, value, receiver) {
      Reflect.set(target, key, value, receiver);
      return true;
    },
    defineProperty(target, key, descriptor) {
      Reflect.defineProperty(target, key, descriptor);
      return true;
    },
    deleteProperty(target, key) {
      Reflect.deleteProperty(target, key);
      return true;
    },
  });
  wasmerNapiSyncGlobalScope(context, wasmerNapiSnapshotGlobal());
  return context;
}
export function wasmer_napi_global_context_scope(context) {
  return context.scope;
}
export function wasmer_napi_activate_global_context(context) {
  wasmerNapiActiveGlobalContext = context;
}
export function wasmer_napi_release_global_context(context) {
  if (wasmerNapiActiveGlobalContext !== context) return;
  wasmerNapiActiveGlobalContext = undefined;
}
export function wasmer_napi_context_eval(sandbox, source) {
  if (wasmerNapiActiveGlobalContext !== undefined &&
      (sandbox == null || sandbox === globalThis ||
       sandbox === wasmerNapiActiveGlobalContext.scope)) {
    sandbox = wasmerNapiActiveGlobalContext.scope;
  }
  if (sandbox == null) return (0, eval)(source);
  return Function('sandbox', 'source',
    'with (sandbox) { return eval(source); }')(sandbox, source);
}
function wasmerNapiLowerDynamicImports(params, source, filename) {
  const names = Array.from(params, String);
  const prefix = `(function(${names.join(',')}) {\n`;
  const program = wasmerNapiParse(`${prefix}${source}\n})`, {
    ecmaVersion: 'latest',
    sourceType: 'script',
  });
  const imports = [];
  const pending = [program];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node == null || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression') imports.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) pending.push(...child);
      else if (child != null && typeof child === 'object') pending.push(child);
    }
  }
  if (imports.length === 0) return source;

  const sourceSlice = (node) => {
    const start = node.start - prefix.length;
    const end = node.end - prefix.length;
    if (start < 0 || end < start || end > source.length) {
      throw new SyntaxError('dynamic import lies outside compiled function source');
    }
    return source.slice(start, end);
  };
  const referrer = JSON.stringify(String(filename ?? ''));
  const replacements = imports.map((node) => {
    const start = node.start - prefix.length;
    const end = node.end - prefix.length;
    const specifier = sourceSlice(node.source);
    const options = node.options == null ? '' : `, ${sourceSlice(node.options)}`;
    return {
      start,
      end,
      text: `__wasmerNapiTrackHostPromise(globalThis.process.__napi_dynamic_import(${specifier}, ${referrer}${options}))`,
    };
  }).sort((left, right) => right.start - left.start);

  for (const replacement of replacements) {
    source = source.slice(0, replacement.start) +
      replacement.text + source.slice(replacement.end);
  }
  return source;
}
export function wasmer_napi_compile_function(scope, contextExtensions, params, source, filename) {
  // V8's compile-function path accepts a hashbang for CommonJS entry files,
  // while the JavaScript Function constructor does not. Preserve byte and
  // line offsets by replacing only the hashbang marker with a line comment.
  if (source.startsWith('#!')) source = '//' + source.slice(2);
  source = wasmerNapiLowerDynamicImports(params, source, filename);
  const names = Array.from(params, String);
  const scopes = [scope, ...Array.from(contextExtensions ?? [])];
  const prefix = scopes.map((_, index) => `with (scopes[${index}]) {`).join('');
  const suffix = '}'.repeat(scopes.length);
  return Function('scopes', '__wasmerNapiTrackHostPromise',
    `${prefix} return function(${names.join(',')}) {\n${source}\n}; ${suffix}`)(
      scopes, wasmerNapiTrackHostPromise);
}
function wasmerNapiCollectBindingNames(pattern, names) {
  if (pattern == null) return;
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      wasmerNapiCollectBindingNames(property.type === 'RestElement' ? property.argument : property.value, names);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) wasmerNapiCollectBindingNames(element, names);
  } else if (pattern.type === 'AssignmentPattern') {
    wasmerNapiCollectBindingNames(pattern.left, names);
  } else if (pattern.type === 'RestElement') {
    wasmerNapiCollectBindingNames(pattern.argument, names);
  }
}
export function wasmer_napi_validate_script(source, filename) {
  wasmerNapiParse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    locations: true,
    sourceFile: filename,
  });
}
export function wasmer_napi_compile_module(scope, source, filename) {
  const program = wasmerNapiParse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  const requests = [];
  const exportNames = [];
  const replacements = [];
  const syntaxReplacements = [];
  let hasTopLevelAwait = false;
  const addExport = (name) => {
    name = String(name);
    if (!exportNames.includes(name)) exportNames.push(name);
  };
  const requestIndex = (node) => {
    const specifier = String(node.source.value);
    const index = requests.length;
    requests.push({ specifier, phase: 2, attributes: Object.create(null) });
    return index;
  };
  const text = (node) => source.slice(node.start, node.end);
  const exportedName = (node) => node.type === 'Identifier' ? node.name : String(node.value);

  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      const index = requestIndex(node);
      const statements = [];
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') {
          statements.push(`const ${specifier.local.name}=__imports[${index}].default;`);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          statements.push(`const ${specifier.local.name}=__imports[${index}];`);
        } else {
          const imported = exportedName(specifier.imported);
          statements.push(`const ${specifier.local.name}=__imports[${index}][${JSON.stringify(imported)}];`);
        }
      }
      replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      addExport('default');
      const declaration = node.declaration;
      if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `${lower(declaration)}\n__exports.default=${declaration.id.name};`,
        });
      } else {
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `__exports.default=(${lower(declaration)});`,
        });
      }
      continue;
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source != null) {
        const index = requestIndex(node);
        const statements = [];
        for (const specifier of node.specifiers) {
          const imported = exportedName(specifier.local);
          const exported = exportedName(specifier.exported);
          addExport(exported);
          statements.push(`__exports[${JSON.stringify(exported)}]=__imports[${index}][${JSON.stringify(imported)}];`);
        }
        replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      } else if (node.declaration != null) {
        const names = [];
        if (node.declaration.type === 'VariableDeclaration') {
          for (const declaration of node.declaration.declarations) {
            wasmerNapiCollectBindingNames(declaration.id, names);
          }
        } else if (node.declaration.id != null) {
          names.push(node.declaration.id.name);
        }
        for (const name of names) addExport(name);
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `${lower(node.declaration)}\n${names.map((name) => `__exports[${JSON.stringify(name)}]=${name};`).join('')}`,
        });
      } else {
        const statements = [];
        for (const specifier of node.specifiers) {
          const local = exportedName(specifier.local);
          const exported = exportedName(specifier.exported);
          addExport(exported);
          statements.push(`__exports[${JSON.stringify(exported)}]=${local};`);
        }
        replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      }
      continue;
    }
    if (node.type === 'ExportAllDeclaration') {
      const index = requestIndex(node);
      if (node.exported != null) {
        const exported = exportedName(node.exported);
        addExport(exported);
        replacements.push({
          start: node.start,
          end: node.end,
          text: `__exports[${JSON.stringify(exported)}]=__imports[${index}];`,
        });
      } else {
        replacements.push({
          start: node.start,
          end: node.end,
          text: `for(const __key of Object.keys(__imports[${index}]))if(__key!=='default')__exports[__key]=__imports[${index}][__key];`,
        });
      }
    }
  }

  const pending = program.body.map((node) => ({ node, functionDepth: 0 }));
  while (pending.length !== 0) {
    const { node, functionDepth } = pending.pop();
    if (node == null || typeof node !== 'object') continue;
    const isFunction = /Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression';
    const childDepth = functionDepth + (isFunction ? 1 : 0);
    if (node.type === 'AwaitExpression' && functionDepth === 0) hasTopLevelAwait = true;
    if (node.type === 'ImportExpression') {
      const options = node.options == null ? '' : `, ${text(node.options)}`;
      syntaxReplacements.push({
        start: node.start,
        end: node.end,
        text: `__wasmerNapiTrackHostPromise(globalThis.process.__napi_dynamic_import(${text(node.source)},${JSON.stringify(String(filename ?? ''))}${options}))`,
      });
    } else if (node.type === 'MetaProperty' && node.meta?.name === 'import' && node.property?.name === 'meta') {
      syntaxReplacements.push({ start: node.start, end: node.end, text: '__importMeta' });
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const value of child) pending.push({ node: value, functionDepth: childDepth });
      } else if (child != null && typeof child === 'object') {
        pending.push({ node: child, functionDepth: childDepth });
      }
    }
  }

  function lower(node) {
    let result = text(node);
    const nested = syntaxReplacements
      .filter((replacement) => replacement.start >= node.start && replacement.end <= node.end)
      .sort((left, right) => right.start - left.start);
    for (const replacement of nested) {
      const start = replacement.start - node.start;
      const end = replacement.end - node.start;
      result = result.slice(0, start) + replacement.text + result.slice(end);
    }
    return result;
  }

  for (const replacement of replacements) {
    if (replacement.render !== undefined) replacement.text = replacement.render();
  }

  // Module-declaration replacements already include any syntax lowering in
  // their declaration/expression. Only apply standalone replacements here.
  for (const replacement of syntaxReplacements) {
    const enclosed = replacements.some((moduleReplacement) =>
      replacement.start >= moduleReplacement.start && replacement.end <= moduleReplacement.end);
    if (!enclosed) replacements.push(replacement);
  }
  replacements.sort((left, right) => right.start - left.start);
  let body = source;
  let replacedStart = source.length + 1;
  for (const replacement of replacements) {
    if (replacement.end > replacedStart) continue;
    body = body.slice(0, replacement.start) + replacement.text + body.slice(replacement.end);
    replacedStart = replacement.start;
  }
  const constructorBody = `${hasTopLevelAwait ? 'return async function' : 'return function'}(__imports,__exports,__importMeta){'use strict';\n${body}\n}`;
  const execute = Function('scope', '__wasmerNapiTrackHostPromise',
    `with(scope){${constructorBody}}`)(scope, wasmerNapiTrackHostPromise);
  return { requests, exportNames, hasTopLevelAwait, execute };
}
export function wasmer_napi_create_module_evaluation() {
  let resolve;
  let reject;
  const promise = new wasmerNapiHostPromise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}
export function wasmer_napi_finish_module_evaluation(
  evaluation, dependencies, execute, imports, namespace, importMeta) {
  wasmerNapiHostPromise.all(dependencies)
    .then(() => execute(imports, namespace, importMeta))
    .then(() => evaluation.resolve(undefined), evaluation.reject);
}
export function wasmer_napi_reject_module_evaluation(evaluation, error) {
  evaluation.reject(error);
}
export function wasmer_napi_typed_array(kind, buffer, offset, length) {
  const names = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'Float16Array'];
  const Ctor = globalThis[names[kind]];
  if (typeof Ctor !== 'function') throw new TypeError('unsupported typed array kind');
  return new Ctor(buffer, offset, length);
}
export function wasmer_napi_typed_array_kind(value) {
  const names = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'Float16Array'];
  // `instanceof globalThis.Uint8Array` rejects genuine views created through
  // Edge's virtual global (and any other same-origin realm). ArrayBuffer's
  // intrinsic brand check is realm-independent; the intrinsic tag then gives
  // us the N-API typed-array enum without trusting the current global's
  // constructors.
  if (!ArrayBuffer.isView(value)) return -1;
  const tag = Object.prototype.toString.call(value);
  return names.indexOf(tag.slice(8, -1));
}
export function wasmer_napi_is_arraybuffer(value) {
  try {
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(value);
    return true;
  } catch {
    return false;
  }
}
export function wasmer_napi_is_dataview(value) {
  try {
    Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get.call(value);
    return true;
  } catch {
    return false;
  }
}
export function wasmer_napi_is_buffer(value) {
  if (wasmerNapiBuffers.has(value)) return true;
  const activeBuffer = wasmerNapiActiveGlobalContext?.scopeTarget?.Buffer;
  if (typeof activeBuffer?.isBuffer === 'function' && activeBuffer.isBuffer(value)) {
    return true;
  }
  const hostBuffer = globalThis.Buffer;
  return hostBuffer !== activeBuffer &&
    typeof hostBuffer?.isBuffer === 'function' && hostBuffer.isBuffer(value);
}
export function wasmer_napi_buffer_view(buffer, offset, length) {
  const view = new Uint8Array(buffer, offset, length);
  wasmerNapiBuffers.add(view);
  const BufferCtor = wasmerNapiActiveGlobalContext?.scopeTarget?.Buffer ?? globalThis.Buffer;
  if (typeof BufferCtor === 'function' && BufferCtor.prototype != null) {
    Object.setPrototypeOf(view, BufferCtor.prototype);
  }
  return view;
}
export function wasmer_napi_get_all_property_names(value, mode, filter, conversion) {
  const result = [];
  const seen = new Set();
  let object = Object(value);
  while (object !== null) {
    for (const key of Reflect.ownKeys(object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof key === 'string') {
        if ((filter & 8) !== 0) continue;
      } else if ((filter & 16) !== 0) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) continue;
      if ((filter & 1) !== 0 && descriptor.writable !== true) continue;
      if ((filter & 2) !== 0 && descriptor.enumerable !== true) continue;
      if ((filter & 4) !== 0 && descriptor.configurable !== true) continue;

      if (conversion === 0 && typeof key === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(key)) {
        const index = Number(key);
        if (index <= 0xfffffffe) {
          result.push(index);
          continue;
        }
      }
      result.push(key);
    }
    if (mode === 1) break;
    object = Object.getPrototypeOf(object);
  }
  return result;
}
const wasmerNapiSerdesState = (() => {
  const key = Symbol.for('wasmer.napi.serdes.state');
  return globalThis[key] ||= { next: 1, values: new Map() };
})();
function wasmerNapiBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('buffer must be an ArrayBuffer or an ArrayBuffer view');
}
function wasmerNapiU32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, Number(value) >>> 0, true);
  return bytes;
}
export function wasmer_napi_structured_clone(value, transferList) {
  if (wasmerNapiHostStructuredClone === undefined) {
    throw new TypeError('structuredClone is not available in this JavaScript host');
  }
  return transferList === undefined
    ? wasmerNapiHostStructuredClone(value)
    : wasmerNapiHostStructuredClone(value, { transfer: Array.from(transferList) });
}
export function wasmer_napi_share_message(value, handle) {
  if (wasmerNapiHostCapiShare === undefined) {
    throw new TypeError('Wasmer host-value sharing is unavailable');
  }
  wasmerNapiHostCapiShare(wasmerNapiMessageRegistryId, handle, { value });
  return handle;
}
export function wasmer_napi_obtain_message(handle) {
  if (wasmerNapiHostCapiObtain === undefined) {
    throw new TypeError('Wasmer host-value sharing is unavailable');
  }
  const envelope = wasmerNapiHostCapiObtain(wasmerNapiMessageRegistryId, handle);
  if (envelope === undefined) {
    throw new TypeError(`Unknown N-API message payload ${handle}`);
  }
  return envelope.value;
}
export function wasmer_napi_wait_for_message(handle) {
  if (wasmerNapiHostCapiWait === undefined) {
    return Promise.reject(new TypeError('Wasmer host-value sharing is unavailable'));
  }
  return wasmerNapiHostCapiWait(wasmerNapiMessageRegistryId, handle);
}
export function wasmer_napi_release_message(handle) {
  wasmerNapiHostCapiDelete?.(wasmerNapiMessageRegistryId, handle);
}
export function wasmer_napi_message_scope() {
  return wasmerNapiHostCapiMessageScope?.() ?? 0;
}
export function wasmer_napi_create_serdes_binding() {
  class Serializer {
    constructor() {
      this.chunks = [];
      this.treatViewsAsHostObjects = false;
    }
    writeHeader() {
      this.chunks.push(Uint8Array.of(0x57, 0x53, 0x48, 0x31));
    }
    writeValue(value) {
      const id = wasmerNapiSerdesState.next++;
      const cloned = wasmerNapiHostStructuredClone !== undefined
        ? wasmerNapiHostStructuredClone(value)
        : value;
      wasmerNapiSerdesState.values.set(id, cloned);
      this.chunks.push(Uint8Array.of(0x57, 0x53, 0x56, 0x31), wasmerNapiU32(id));
      return true;
    }
    releaseBuffer() {
      const length = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of this.chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.chunks = [];
      return out;
    }
    transferArrayBuffer() {}
    writeUint32(value) { this.chunks.push(wasmerNapiU32(value)); }
    writeUint64(low, high = 0) {
      this.writeUint32(low);
      this.writeUint32(high);
    }
    writeDouble(value) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, Number(value), true);
      this.chunks.push(bytes);
    }
    writeRawBytes(value) { this.chunks.push(wasmerNapiBytes(value).slice()); }
    _setTreatArrayBufferViewsAsHostObjects(value) {
      this.treatViewsAsHostObjects = Boolean(value);
    }
  }
  class Deserializer {
    constructor(value) {
      this.buffer = value;
      this.bytes = wasmerNapiBytes(value);
      this.offset = 0;
    }
    readHeader() {
      if (this.bytes.length - this.offset < 4 ||
          this.bytes[this.offset] !== 0x57 || this.bytes[this.offset + 1] !== 0x53 ||
          this.bytes[this.offset + 2] !== 0x48 || this.bytes[this.offset + 3] !== 0x31) {
        return false;
      }
      this.offset += 4;
      return true;
    }
    readValue() {
      if (this.bytes.length - this.offset < 8 ||
          this.bytes[this.offset] !== 0x57 || this.bytes[this.offset + 1] !== 0x53 ||
          this.bytes[this.offset + 2] !== 0x56 || this.bytes[this.offset + 3] !== 0x31) {
        throw new Error('Invalid Wasmer serializer payload');
      }
      this.offset += 4;
      const id = this.readUint32();
      if (!wasmerNapiSerdesState.values.has(id)) {
        throw new Error('Wasmer serializer payload is no longer available');
      }
      const value = wasmerNapiSerdesState.values.get(id);
      wasmerNapiSerdesState.values.delete(id);
      return wasmerNapiHostStructuredClone !== undefined
        ? wasmerNapiHostStructuredClone(value)
        : value;
    }
    getWireFormatVersion() { return 15; }
    transferArrayBuffer() {}
    readUint32() {
      if (this.bytes.length - this.offset < 4) throw new RangeError('Unexpected end of buffer');
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4)
        .getUint32(0, true);
      this.offset += 4;
      return value;
    }
    readUint64() {
      const low = this.readUint32();
      const high = this.readUint32();
      return high * 0x100000000 + low;
    }
    readDouble() {
      if (this.bytes.length - this.offset < 8) throw new RangeError('Unexpected end of buffer');
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8)
        .getFloat64(0, true);
      this.offset += 8;
      return value;
    }
    _readRawBytes(length) {
      const size = Number(length) >>> 0;
      if (this.bytes.length - this.offset < size) throw new RangeError('Unexpected end of buffer');
      const offset = this.offset;
      this.offset += size;
      return offset;
    }
  }
  return { Serializer, Deserializer };
}
"#)]
extern "C" {
    fn wasmer_napi_make_callback(dispatch: &Function) -> Function;
    fn wasmer_napi_enqueue_microtask(callback: &Function);
    fn wasmer_napi_event_loop_checkpoint(
        allow_host_tasks: bool,
        has_runnable_work: bool,
    ) -> Promise;
    fn wasmer_napi_has_pending_provider_work() -> bool;
    fn wasmer_napi_get_promise_details(promise: &JsValue) -> Array;
    fn wasmer_napi_has_jspi() -> bool;
    fn wasmer_napi_instanceof(value: &JsValue, ctor: &JsValue) -> bool;
    fn wasmer_napi_new(ctor: &Function, args: &Array) -> JsValue;
    fn wasmer_napi_symbol(description: &JsValue) -> JsValue;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_string(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_number(value: &JsValue) -> Result<JsValue, JsValue>;
    fn wasmer_napi_console_error(message: &str);
    fn wasmer_napi_create_global_context() -> JsValue;
    fn wasmer_napi_global_context_scope(context: &JsValue) -> JsValue;
    fn wasmer_napi_activate_global_context(context: &JsValue);
    fn wasmer_napi_release_global_context(context: &JsValue);
    #[wasm_bindgen(catch)]
    fn wasmer_napi_context_eval(sandbox: &JsValue, source: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_compile_function(
        scope: &JsValue,
        context_extensions: &Array,
        params: &Array,
        source: &str,
        filename: &str,
    ) -> Result<Function, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_compile_module(
        scope: &JsValue,
        source: &str,
        filename: &str,
    ) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_validate_script(source: &str, filename: &str) -> Result<(), JsValue>;
    fn wasmer_napi_create_module_evaluation() -> Object;
    fn wasmer_napi_finish_module_evaluation(
        evaluation: &Object,
        dependencies: &Array,
        execute: &Function,
        imports: &Array,
        namespace: &Object,
        import_meta: &Object,
    );
    fn wasmer_napi_reject_module_evaluation(evaluation: &Object, error: &JsValue);
    #[wasm_bindgen(catch)]
    fn wasmer_napi_typed_array(
        kind: i32,
        buffer: &JsValue,
        offset: u32,
        length: u32,
    ) -> Result<JsValue, JsValue>;
    fn wasmer_napi_typed_array_kind(value: &JsValue) -> i32;
    fn wasmer_napi_is_arraybuffer(value: &JsValue) -> bool;
    fn wasmer_napi_is_dataview(value: &JsValue) -> bool;
    fn wasmer_napi_is_buffer(value: &JsValue) -> bool;
    fn wasmer_napi_buffer_view(buffer: &JsValue, offset: u32, length: u32) -> JsValue;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_get_all_property_names(
        value: &JsValue,
        mode: i32,
        filter: i32,
        conversion: i32,
    ) -> Result<Array, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_structured_clone(
        value: &JsValue,
        transfer_list: &JsValue,
    ) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_share_message(value: &JsValue, handle: u32) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_obtain_message(handle: u32) -> Result<JsValue, JsValue>;
    fn wasmer_napi_wait_for_message(handle: u32) -> Promise;
    fn wasmer_napi_release_message(handle: u32);
    fn wasmer_napi_message_scope() -> u32;
    #[wasm_bindgen(catch)]
    fn wasmer_napi_create_serdes_binding() -> Result<JsValue, JsValue>;
}

pub(crate) fn has_jspi() -> bool {
    wasmer_napi_has_jspi()
}

pub(crate) async fn event_loop_checkpoint(
    allow_host_tasks: bool,
    has_runnable_work: bool,
) -> Result<JsValue, JsValue> {
    JsFuture::from(wasmer_napi_event_loop_checkpoint(
        allow_host_tasks,
        has_runnable_work,
    ))
    .await
}

pub(crate) async fn wait_for_message(handle: u32) -> Result<JsValue, JsValue> {
    JsFuture::from(wasmer_napi_wait_for_message(handle)).await
}

struct Deferred {
    resolve: Function,
    reject: Function,
}

struct Reference {
    strong: Option<JsValue>,
    weak: Option<WeakRef<Object>>,
    count: u32,
}

#[derive(Clone, Copy)]
struct CallbackReg {
    guest_env: u32,
    wasm_fn_ptr: u32,
    data: u64,
}

struct CallbackInfo {
    args: Vec<u32>,
    this_value: u32,
    data: u64,
}

struct PendingCallback {
    registration: CallbackReg,
    cbinfo: u32,
    value_frame: u32,
    resolve: Function,
    reject: Function,
}

struct ValueFrame {
    id: u32,
    handles: Vec<u32>,
}

struct GuestFinalizer {
    target: WeakRef<Object>,
    guest_env: u32,
    wasm_fn_ptr: u32,
    data: u32,
    hint: u32,
    wrap_id: Option<u32>,
}

struct GuestBufferFinalizer {
    target: WeakRef<Object>,
    handle_id: u32,
    guest_ptr: u32,
    recyclable: bool,
}

struct SyntheticModule {
    wrapper: JsValue,
    export_names: Vec<String>,
    evaluate: Function,
    namespace: Object,
    status: i32,
    error: Option<JsValue>,
    evaluation: Option<JsValue>,
}

struct SourceTextModule {
    url: String,
    requests: Array,
    linked_handles: Vec<u32>,
    execute: Function,
    namespace: Object,
    has_top_level_await: bool,
    status: i32,
    error: Option<JsValue>,
    evaluation: Option<JsValue>,
}

struct HostJsEnv {
    values: Vec<UnsafeCell<JsValue>>,
    value_live: Vec<bool>,
    value_free_slots: Vec<u32>,
    value_handles: HashMap<u32, u32>,
    next_value_handle: u32,
    value_frames: Vec<ValueFrame>,
    next_value_frame: u32,
    object_ids: WeakMap,
    wrap_ids: WeakMap,
    next_wrap_id: u32,
    backing_store_ids: WeakMap,
    next_backing_store_id: u32,
    global_context: JsValue,
    live_env_addr: Rc<Cell<usize>>,
    last_exception: Option<JsValue>,
    active_callback_ctx: *mut c_void,
    next_deferred: u32,
    deferreds: HashMap<u32, Deferred>,
    next_reference: u32,
    references: HashMap<u32, Reference>,
    next_callback: u32,
    callback_regs: HashMap<u32, CallbackReg>,
    next_cbinfo: u32,
    callback_infos: HashMap<u32, CallbackInfo>,
    pending_callbacks: VecDeque<PendingCallback>,
    closures: Vec<Closure<dyn Fn(JsValue, Array) -> JsValue>>,
    instance_data: u64,
    wraps: HashMap<u32, u64>,
    guest_finalizers: Vec<GuestFinalizer>,
    guest_buffer_finalizers: Vec<GuestBufferFinalizer>,
    externals: HashMap<u32, u64>,
    backing_tokens: HashMap<u32, u64>,
    type_tags: HashMap<u32, (u64, u64)>,
    next_module: u32,
    next_bytecode: u32,
    bytecodes: HashMap<u32, HostJsBytecode>,
    synthetic_modules: HashMap<u32, SyntheticModule>,
    source_text_modules: HashMap<u32, SourceTextModule>,
    embedder_hooks_attached: bool,
}

struct HostJsBytecode {
    source: JsValue,
    shape: i32,
}

fn host_js_source_for_shape(
    state: &HostJsEnv,
    source_text_id: u32,
    source_bytecode_id: u32,
    expected_shape: i32,
) -> Result<String, i32> {
    if source_text_id != 0 {
        return state
            .get(source_text_id)
            .and_then(JsValue::as_string)
            .ok_or(NAPI_STRING_EXPECTED);
    }
    let bytecode = state
        .bytecodes
        .get(&source_bytecode_id)
        .ok_or(NAPI_INVALID_ARG)?;
    if bytecode.shape != expected_shape {
        return Err(NAPI_INVALID_ARG);
    }
    bytecode.source.as_string().ok_or(NAPI_STRING_EXPECTED)
}

impl HostJsEnv {
    fn new() -> Self {
        // Handle zero is N-API's null pointer sentinel, never a JS value.
        Self {
            values: Vec::new(),
            value_live: Vec::new(),
            value_free_slots: Vec::new(),
            value_handles: HashMap::new(),
            next_value_handle: 1,
            // The root frame owns values created outside an explicit handle
            // scope and receives values escaped from the outermost scope.
            value_frames: vec![ValueFrame {
                id: 1,
                handles: Vec::new(),
            }],
            next_value_frame: 2,
            object_ids: WeakMap::new(),
            wrap_ids: WeakMap::new(),
            next_wrap_id: 1,
            backing_store_ids: WeakMap::new(),
            next_backing_store_id: 1,
            global_context: wasmer_napi_create_global_context(),
            live_env_addr: Rc::new(Cell::new(0)),
            last_exception: None,
            active_callback_ctx: ptr::null_mut(),
            next_deferred: 1,
            deferreds: HashMap::new(),
            next_reference: 1,
            references: HashMap::new(),
            next_callback: 1,
            callback_regs: HashMap::new(),
            next_cbinfo: 1,
            callback_infos: HashMap::new(),
            pending_callbacks: VecDeque::new(),
            closures: Vec::new(),
            instance_data: 0,
            wraps: HashMap::new(),
            guest_finalizers: Vec::new(),
            guest_buffer_finalizers: Vec::new(),
            externals: HashMap::new(),
            backing_tokens: HashMap::new(),
            type_tags: HashMap::new(),
            next_module: 1,
            next_bytecode: 1,
            bytecodes: HashMap::new(),
            synthetic_modules: HashMap::new(),
            source_text_modules: HashMap::new(),
            embedder_hooks_attached: false,
        }
    }

    fn insert(&mut self, value: JsValue) -> u32 {
        let object = if value.is_object() || value.is_function() {
            Some(value.clone().unchecked_into::<Object>())
        } else {
            None
        };
        let previous_id = object.as_ref().and_then(|object| {
            self.object_ids
                .get_checked(object)
                .and_then(|id| id.as_f64())
                .map(|id| id as u32)
        });
        if let Some(id) = previous_id
            && self
                .get(id)
                .is_some_and(|existing| Object::is(existing, &value))
        {
            return id;
        }

        let index = if let Some(index) = self.value_free_slots.pop() {
            unsafe { *self.values[index as usize].get() = value };
            self.value_live[index as usize] = true;
            index
        } else {
            let index = self.values.len() as u32;
            self.values.push(UnsafeCell::new(value));
            self.value_live.push(true);
            index
        };
        // Handles are opaque guest tokens. Keep their identity independent of
        // reusable storage slots: packing both into u32 either caps live slots
        // (too many generation bits) or aliases stale handles under sustained
        // reuse (too few). A monotonically unique token plus an indirection map
        // gives us the full non-zero u32 namespace for both properties.
        let id = loop {
            let candidate = self.next_value_handle.max(1);
            self.next_value_handle = candidate.wrapping_add(1).max(1);
            if !self.value_handles.contains_key(&candidate) {
                break candidate;
            }
        };
        self.value_handles.insert(id, index);
        if let Some(frame) = self.value_frames.last_mut() {
            frame.handles.push(id);
        }
        if let Some(object) = object.as_ref() {
            self.object_ids.set(object, &JsValue::from_f64(id as f64));
        }
        if let Some(previous_id) = previous_id {
            if let Some(value) = self.externals.remove(&previous_id) {
                self.externals.insert(id, value);
            }
            if let Some(value) = self.backing_tokens.remove(&previous_id) {
                self.backing_tokens.insert(id, value);
            }
            if let Some(value) = self.type_tags.remove(&previous_id) {
                self.type_tags.insert(id, value);
            }
        }
        id
    }

    fn wrap_id(&mut self, value_id: u32, create: bool) -> Option<u32> {
        let value = self.get(value_id)?.clone();
        if !value.is_object() && !value.is_function() {
            return None;
        }
        let object = value.unchecked_into::<Object>();
        if let Some(id) = self
            .wrap_ids
            .get_checked(&object)
            .and_then(|id| id.as_f64())
            .map(|id| id as u32)
        {
            return Some(id);
        }
        if !create {
            return None;
        }
        let id = self.next_wrap_id.max(1);
        self.next_wrap_id = id.saturating_add(1);
        self.wrap_ids.set(&object, &JsValue::from_f64(id as f64));
        Some(id)
    }

    fn register_guest_finalizer(
        &mut self,
        value_id: u32,
        guest_env: u32,
        wasm_fn_ptr: u32,
        data: u32,
        hint: u32,
        wrap_id: Option<u32>,
    ) -> bool {
        let Some(value) = self.get(value_id).cloned() else {
            return false;
        };
        if !value.is_object() && !value.is_function() {
            return false;
        }
        let target = WeakRef::new(&value.unchecked_into::<Object>());
        self.guest_finalizers.push(GuestFinalizer {
            target,
            guest_env,
            wasm_fn_ptr,
            data,
            hint,
            wrap_id,
        });
        true
    }

    fn take_ready_guest_finalizer(&mut self, force: bool) -> Option<GuestFinalizer> {
        let index = self
            .guest_finalizers
            .iter()
            .position(|record| force || record.target.deref().is_none())?;
        Some(self.guest_finalizers.swap_remove(index))
    }

    fn take_ready_guest_buffer_finalizer(&mut self, force: bool) -> Option<GuestBufferFinalizer> {
        let index = self
            .guest_buffer_finalizers
            .iter()
            .position(|record| force || record.target.deref().is_none())?;
        Some(self.guest_buffer_finalizers.swap_remove(index))
    }

    fn backing_store_token(&mut self, id: u32) -> Option<u64> {
        let value = self.get(id)?.clone();
        let (buffer, byte_offset) = if value.is_instance_of::<ArrayBuffer>()
            || value.is_instance_of::<SharedArrayBuffer>()
        {
            (value, 0u32)
        } else if ArrayBuffer::is_view(&value) {
            let buffer = Reflect::get(&value, &JsValue::from_str("buffer")).ok()?;
            let byte_offset = Reflect::get(&value, &JsValue::from_str("byteOffset"))
                .ok()?
                .as_f64()? as u32;
            (buffer, byte_offset)
        } else {
            return None;
        };
        let object = buffer.unchecked_into::<Object>();
        let buffer_id = self
            .backing_store_ids
            .get_checked(&object)
            .and_then(|id| id.as_f64())
            .map(|id| id as u32)
            .unwrap_or_else(|| {
                let id = self.next_backing_store_id.max(1);
                self.next_backing_store_id = id.wrapping_add(1).max(1);
                self.backing_store_ids
                    .set(&object, &JsValue::from_f64(id as f64));
                id
            });
        Some(
            JS_BACKING_TOKEN_MARKER
                | ((u64::from(buffer_id) & 0x7fff_ffff) << 32)
                | u64::from(byte_offset),
        )
    }

    fn get(&self, id: u32) -> Option<&JsValue> {
        if id == 0 {
            return None;
        }
        let index = *self.value_handles.get(&id)? as usize;
        if !self.value_live.get(index).copied().unwrap_or(false) {
            return None;
        }
        let value = self.values.get(index)?;
        Some(unsafe { &*value.get() })
    }

    fn activate(&self) {
        wasmer_napi_activate_global_context(&self.global_context);
    }

    fn open_value_frame(&mut self) -> u32 {
        let id = self.next_value_frame.max(1);
        self.next_value_frame = id.saturating_add(1);
        self.value_frames.push(ValueFrame {
            id,
            handles: Vec::new(),
        });
        id
    }

    fn release_value_handles(&mut self, handles: Vec<u32>) {
        for id in handles {
            if id == 0 {
                continue;
            }
            let Some(index) = self.value_handles.remove(&id).map(|index| index as usize) else {
                continue;
            };
            if !self.value_live.get(index).copied().unwrap_or(false) {
                continue;
            }
            self.value_live[index] = false;
            unsafe { *self.values[index].get() = JsValue::UNDEFINED };
            self.value_free_slots.push(index as u32);
        }
    }

    fn close_value_frame(&mut self, id: u32) -> bool {
        if self.value_frames.last().map(|frame| frame.id) != Some(id) {
            return false;
        }
        let frame = self.value_frames.pop().expect("value frame disappeared");
        self.release_value_handles(frame.handles);
        true
    }

    fn escape_value(&mut self, frame_id: u32, value_id: u32) -> bool {
        let Some(index) = self
            .value_frames
            .iter()
            .rposition(|frame| frame.id == frame_id)
        else {
            return false;
        };
        let Some(position) = self.value_frames[index]
            .handles
            .iter()
            .position(|id| *id == value_id)
        else {
            return false;
        };
        self.value_frames[index].handles.swap_remove(position);
        if index == 0 {
            return false;
        }
        self.value_frames[index - 1].handles.push(value_id);
        true
    }
}

thread_local! {
    static BUFFER_ALLOCS: RefCell<HashMap<usize, Box<[u8]>>> = RefCell::new(HashMap::new());
    // N-API calls normally arrive in long runs from one guest environment.
    // Realm activation is only a context switch; repeating its wasm-bindgen
    // call before every operation doubles the host boundary crossings on the
    // hottest path without changing observable state.
    static ACTIVE_HOST_JS_ENV: Cell<usize> = const { Cell::new(0) };
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_configure_runtime(
    engine_flags: *const i8,
    engine_flags_length: u32,
) -> i32 {
    if engine_flags_length > 0 && engine_flags.is_null() {
        return NAPI_INVALID_ARG;
    }
    let requested = if engine_flags_length == 0 {
        Vec::new()
    } else {
        unsafe {
            slice::from_raw_parts(engine_flags.cast::<u8>(), engine_flags_length as usize).to_vec()
        }
    };
    let Ok(mut configured) = RUNTIME_ENGINE_FLAGS.lock() else {
        return NAPI_GENERIC_FAILURE;
    };
    match configured.as_ref() {
        Some(existing) if existing != &requested => NAPI_INVALID_ARG,
        Some(_) => NAPI_OK,
        None => {
            *configured = Some(requested);
            NAPI_OK
        }
    }
}

unsafe fn env_mut<'a>(env: SnapiEnv) -> Result<&'a mut HostJsEnv, i32> {
    if env.is_null() {
        return Err(NAPI_INVALID_ARG);
    }
    let state = unsafe { &mut *env.cast::<HostJsEnv>() };
    let env_addr = env as usize;
    ACTIVE_HOST_JS_ENV.with(|active| {
        if active.get() != env_addr {
            state.activate();
            active.set(env_addr);
        }
    });
    Ok(state)
}

fn evaluation_scope(state: &HostJsEnv, context_id: u32) -> Result<JsValue, i32> {
    if context_id == 0 {
        return Ok(wasmer_napi_global_context_scope(&state.global_context));
    }
    let Some(context) = state.get(context_id) else {
        return Err(NAPI_INVALID_ARG);
    };
    if context.is_null() || context.is_undefined() {
        Ok(wasmer_napi_global_context_scope(&state.global_context))
    } else {
        Ok(context.clone())
    }
}

unsafe fn write<T>(out: *mut T, value: T) -> Result<(), i32> {
    if out.is_null() {
        return Err(NAPI_INVALID_ARG);
    }
    unsafe { out.write(value) };
    Ok(())
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], i32> {
    if ptr.is_null() && len != 0 {
        return Err(NAPI_INVALID_ARG);
    }
    Ok(if len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len) }
    })
}

unsafe fn bytes_with_auto_length<'a>(ptr: *const u8, len: u32) -> Result<&'a [u8], i32> {
    if len == u32::MAX {
        if ptr.is_null() {
            return Err(NAPI_INVALID_ARG);
        }
        return Ok(unsafe { CStr::from_ptr(ptr.cast()) }.to_bytes());
    }
    unsafe { bytes(ptr, len as usize) }
}

unsafe fn cstr(ptr: *const i8) -> Result<String, i32> {
    if ptr.is_null() {
        return Err(NAPI_INVALID_ARG);
    }
    Ok(unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned())
}

fn store_bytes(data: Vec<u8>) -> u64 {
    if data.is_empty() {
        return 0;
    }
    let mut data = data.into_boxed_slice();
    let ptr = data.as_mut_ptr() as usize;
    BUFFER_ALLOCS.with(|allocs| allocs.borrow_mut().insert(ptr, data));
    ptr as u64
}

fn value_byte_view(value: &JsValue) -> Option<Uint8Array> {
    if value.is_instance_of::<ArrayBuffer>() || value.is_instance_of::<SharedArrayBuffer>() {
        return Some(Uint8Array::new(value));
    }
    if ArrayBuffer::is_view(value) {
        let buffer = Reflect::get(value, &JsValue::from_str("buffer")).ok()?;
        let byte_offset = Reflect::get(value, &JsValue::from_str("byteOffset"))
            .ok()?
            .as_f64()? as u32;
        let byte_length = Reflect::get(value, &JsValue::from_str("byteLength"))
            .ok()?
            .as_f64()? as u32;
        return Some(Uint8Array::new_with_byte_offset_and_length(
            &buffer,
            byte_offset,
            byte_length,
        ));
    }
    None
}

fn value_bytes(value: &JsValue) -> Option<Vec<u8>> {
    Some(value_byte_view(value)?.to_vec())
}

pub(crate) fn get_value_byte_length_and_token(env: SnapiEnv, id: u32) -> Result<(u32, u64), i32> {
    let state = unsafe { env_mut(env) }?;
    let value = state.get(id).ok_or(NAPI_INVALID_ARG)?;
    let byte_len = value_byte_view(value).ok_or(NAPI_INVALID_ARG)?.length();
    let token = state.backing_store_token(id).unwrap_or(id as u64);
    Ok((byte_len, token))
}

pub(crate) fn copy_value_bytes_to_memory(
    env: SnapiEnv,
    id: u32,
    memory_buffer: &JsValue,
    guest_ptr: u32,
    byte_len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = value_byte_view(value) else {
        return NAPI_INVALID_ARG;
    };
    if byte_len > source.length() {
        return NAPI_INVALID_ARG;
    }
    let destination =
        Uint8Array::new_with_byte_offset_and_length(memory_buffer, guest_ptr, byte_len);
    destination.set(&source.subarray(0, byte_len), 0);
    NAPI_OK
}

pub(crate) fn copy_value_range_to_memory(
    env: SnapiEnv,
    id: u32,
    memory_buffer: &JsValue,
    guest_ptr: u32,
    byte_offset: u32,
    byte_len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = value_byte_view(value) else {
        return NAPI_INVALID_ARG;
    };
    let Some(end) = byte_offset.checked_add(byte_len) else {
        return NAPI_INVALID_ARG;
    };
    if end > source.length() {
        return NAPI_INVALID_ARG;
    }
    let destination =
        Uint8Array::new_with_byte_offset_and_length(memory_buffer, guest_ptr, byte_len);
    destination.set(&source.subarray(byte_offset, end), 0);
    NAPI_OK
}

pub(crate) fn copy_memory_bytes_to_reference(
    env: SnapiEnv,
    reference_id: u32,
    memory_buffer: &JsValue,
    guest_ptr: u32,
    byte_len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(reference) = state.references.get(&reference_id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = reference.strong.clone().or_else(|| {
        reference
            .weak
            .as_ref()
            .and_then(WeakRef::deref)
            .map(Into::into)
    }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(destination) = value_byte_view(&value) else {
        return NAPI_INVALID_ARG;
    };
    if byte_len > destination.length() {
        return NAPI_INVALID_ARG;
    }
    let source = Uint8Array::new_with_byte_offset_and_length(memory_buffer, guest_ptr, byte_len);
    destination.subarray(0, byte_len).set(&source, 0);
    NAPI_OK
}

pub(crate) fn copy_reference_bytes_to_memory(
    env: SnapiEnv,
    reference_id: u32,
    memory_buffer: &JsValue,
    guest_ptr: u32,
    byte_len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(reference) = state.references.get(&reference_id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = reference.strong.clone().or_else(|| {
        reference
            .weak
            .as_ref()
            .and_then(WeakRef::deref)
            .map(Into::into)
    }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = value_byte_view(&value) else {
        return NAPI_INVALID_ARG;
    };
    if byte_len > source.length() {
        return NAPI_INVALID_ARG;
    }
    let destination =
        Uint8Array::new_with_byte_offset_and_length(memory_buffer, guest_ptr, byte_len);
    destination.set(&source.subarray(0, byte_len), 0);
    NAPI_OK
}

pub(crate) fn copy_memory_range_to_reference(
    env: SnapiEnv,
    reference_id: u32,
    memory_buffer: &JsValue,
    guest_ptr: u32,
    byte_offset: u32,
    byte_len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(reference) = state.references.get(&reference_id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = reference.strong.as_ref() else {
        return NAPI_INVALID_ARG;
    };
    let Some(destination) = value_byte_view(value) else {
        return NAPI_INVALID_ARG;
    };
    let Some(end) = byte_offset.checked_add(byte_len) else {
        return NAPI_INVALID_ARG;
    };
    if end > destination.length() {
        return NAPI_INVALID_ARG;
    }
    let source = Uint8Array::new_with_byte_offset_and_length(memory_buffer, guest_ptr, byte_len);
    destination.subarray(byte_offset, end).set(&source, 0);
    NAPI_OK
}

unsafe fn put_value(env: SnapiEnv, out: *mut u32, value: JsValue) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(value);
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}

fn js_string(value: &JsValue) -> Result<String, JsValue> {
    if let Some(value) = value.as_string() {
        return Ok(value);
    }
    Ok(wasmer_napi_string(value)?.as_string().unwrap_or_default())
}

fn is_array_index_key(value: &str) -> bool {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return false;
    }
    value
        .parse::<u32>()
        .is_ok_and(|index| index != u32::MAX && index.to_string() == value)
}

fn napi_typeof(value: &JsValue) -> i32 {
    // napi_valuetype: undefined, null, boolean, number, string, symbol,
    // object, function, external, bigint.
    if value.is_undefined() {
        0
    } else if value.is_null() {
        1
    } else if value.as_bool().is_some() {
        2
    } else if value.as_f64().is_some() {
        3
    } else if value.as_string().is_some() {
        4
    } else if value.is_symbol() {
        5
    } else if value.is_function() {
        7
    } else if value.is_bigint() {
        9
    } else {
        6
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_init() -> i32 {
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_create_env(
    _version: i32,
    _guest_heap_ctx: *const c_void,
    out: *mut SnapiEnv,
) -> i32 {
    let runtime_configured = RUNTIME_ENGINE_FLAGS
        .lock()
        .is_ok_and(|flags| flags.is_some());
    if out.is_null() || !runtime_configured {
        return NAPI_INVALID_ARG;
    }
    let env = Box::new(HostJsEnv::new());
    env.live_env_addr.set((&*env as *const HostJsEnv) as usize);
    unsafe { out.write(Box::into_raw(env).cast::<SnapiEnvState>()) };
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_create_env_with_options(
    version: i32,
    _total_memory: u64,
    _constrained_memory: u64,
    _young: u32,
    _old: u32,
    _code: u32,
    _stack: u32,
    guest_heap_ctx: *const c_void,
    out: *mut SnapiEnv,
) -> i32 {
    unsafe { snapi_bridge_unofficial_create_env(version, guest_heap_ctx, out) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_release_env(env: SnapiEnv) -> i32 {
    if env.is_null() {
        return NAPI_INVALID_ARG;
    }
    let mut state = unsafe { Box::from_raw(env.cast::<HostJsEnv>()) };
    let env_addr = env as usize;
    ACTIVE_HOST_JS_ENV.with(|active| {
        if active.get() == env_addr {
            active.set(0);
        }
    });
    state.live_env_addr.set(0);
    wasmer_napi_release_global_context(&state.global_context);
    // JavaScript can retain callbacks through globals, event listeners, and
    // pending tasks after the N-API environment is released. Keep only the
    // wasm-bindgen trampoline alive; its shared liveness token makes retained
    // callbacks inert without retaining or dereferencing the freed environment.
    for closure in state.closures.drain(..) {
        closure.forget();
    }
    drop(state);
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_release_env_with_loop(
    env: SnapiEnv,
    _loop_id: u32,
) -> i32 {
    unsafe { snapi_bridge_unofficial_release_env(env) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_free_buffer(data: *mut c_void) {
    if !data.is_null() {
        BUFFER_ALLOCS.with(|allocs| {
            allocs.borrow_mut().remove(&(data as usize));
        });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_undefined(env: SnapiEnv, out: *mut u32) -> i32 {
    unsafe { put_value(env, out, JsValue::UNDEFINED) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_null(env: SnapiEnv, out: *mut u32) -> i32 {
    unsafe { put_value(env, out, JsValue::NULL) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_boolean(env: SnapiEnv, value: i32, out: *mut u32) -> i32 {
    unsafe { put_value(env, out, JsValue::from_bool(value != 0)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_global(env: SnapiEnv, out: *mut u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let global = wasmer_napi_global_context_scope(&state.global_context);
    let id = state.insert(global);
    unsafe { write(out, id) }.map_or_else(|error| error, |()| NAPI_OK)
}

unsafe fn create_string(
    env: SnapiEnv,
    ptr: *const u8,
    len: u32,
    out: *mut u32,
    latin1: bool,
) -> i32 {
    let Ok(raw) = (unsafe { bytes_with_auto_length(ptr, len) }) else {
        return NAPI_INVALID_ARG;
    };
    let value = if latin1 {
        raw.iter().map(|b| char::from(*b)).collect::<String>()
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    unsafe { put_value(env, out, JsValue::from_str(&value)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_string_utf8(
    env: SnapiEnv,
    ptr: *const i8,
    len: u32,
    out: *mut u32,
) -> i32 {
    unsafe { create_string(env, ptr.cast(), len, out, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_string_latin1(
    env: SnapiEnv,
    ptr: *const i8,
    len: u32,
    out: *mut u32,
) -> i32 {
    unsafe { create_string(env, ptr.cast(), len, out, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_string_utf16(
    env: SnapiEnv,
    ptr: *const u16,
    len: u32,
    out: *mut u32,
) -> i32 {
    let raw = if ptr.is_null() && len != 0 {
        return NAPI_INVALID_ARG;
    } else if len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len as usize) }
    };
    unsafe { put_value(env, out, JsValue::from_str(&String::from_utf16_lossy(raw))) }
}

unsafe fn read_string_bytes(
    env: SnapiEnv,
    id: u32,
    buf: *mut u8,
    size: usize,
    result: *mut usize,
    latin1: bool,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(text) = value.as_string() else {
        return NAPI_STRING_EXPECTED;
    };
    let encoded = if latin1 {
        text.chars().map(|c| c as u32 as u8).collect()
    } else {
        text.into_bytes()
    };
    if unsafe { write(result, encoded.len()) }.is_err() {
        return NAPI_INVALID_ARG;
    }
    if !buf.is_null() && size != 0 {
        let count = encoded.len().min(size.saturating_sub(1));
        unsafe {
            ptr::copy_nonoverlapping(encoded.as_ptr(), buf, count);
            buf.add(count).write(0);
        }
        unsafe { result.write(count) };
    }
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_string_utf8(
    env: SnapiEnv,
    id: u32,
    buf: *mut i8,
    size: usize,
    result: *mut usize,
) -> i32 {
    unsafe { read_string_bytes(env, id, buf.cast(), size, result, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_string_latin1(
    env: SnapiEnv,
    id: u32,
    buf: *mut i8,
    size: usize,
    result: *mut usize,
) -> i32 {
    unsafe { read_string_bytes(env, id, buf.cast(), size, result, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_string_utf16(
    env: SnapiEnv,
    id: u32,
    buf: *mut u16,
    size: usize,
    result: *mut usize,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(text) = state.get(id).and_then(JsValue::as_string) else {
        return NAPI_STRING_EXPECTED;
    };
    let encoded: Vec<u16> = text.encode_utf16().collect();
    if unsafe { write(result, encoded.len()) }.is_err() {
        return NAPI_INVALID_ARG;
    }
    if !buf.is_null() && size != 0 {
        let count = encoded.len().min(size.saturating_sub(1));
        unsafe {
            ptr::copy_nonoverlapping(encoded.as_ptr(), buf, count);
            buf.add(count).write(0);
            result.write(count);
        }
    }
    NAPI_OK
}

macro_rules! create_number {
    ($name:ident, $ty:ty) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(env: SnapiEnv, value: $ty, out: *mut u32) -> i32 {
            unsafe { put_value(env, out, JsValue::from_f64(value as f64)) }
        }
    };
}
create_number!(snapi_bridge_create_int32, i32);
create_number!(snapi_bridge_create_uint32, u32);
create_number!(snapi_bridge_create_int64, i64);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_double(
    env: SnapiEnv,
    value: f64,
    out: *mut u32,
) -> i32 {
    unsafe { put_value(env, out, JsValue::from_f64(value)) }
}

macro_rules! read_number {
    ($name:ident, $ty:ty) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(env: SnapiEnv, id: u32, out: *mut $ty) -> i32 {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let Some(value) = state.get(id).and_then(JsValue::as_f64) else {
                return NAPI_INVALID_ARG;
            };
            unsafe { write(out, value as $ty) }.map_or_else(|e| e, |_| NAPI_OK)
        }
    };
}
read_number!(snapi_bridge_get_value_int32, i32);
read_number!(snapi_bridge_get_value_uint32, u32);
read_number!(snapi_bridge_get_value_int64, i64);
read_number!(snapi_bridge_get_value_double, f64);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_bool(env: SnapiEnv, id: u32, out: *mut i32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).and_then(JsValue::as_bool) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(out, i32::from(value)) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_object(env: SnapiEnv, out: *mut u32) -> i32 {
    unsafe { put_value(env, out, Object::new().into()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_array(env: SnapiEnv, out: *mut u32) -> i32 {
    unsafe { put_value(env, out, Array::new().into()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_array_with_length(
    env: SnapiEnv,
    len: u32,
    out: *mut u32,
) -> i32 {
    unsafe { put_value(env, out, Array::new_with_length(len).into()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_typeof(env: SnapiEnv, id: u32, out: *mut i32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let typ = if state.externals.contains_key(&id) {
        8 // napi_external
    } else {
        napi_typeof(value)
    };
    unsafe { write(out, typ) }.map_or_else(|e| e, |_| NAPI_OK)
}

macro_rules! type_test {
    ($name:ident, $test:expr) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(env: SnapiEnv, id: u32, out: *mut i32) -> i32 {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let Some(value) = state.get(id) else {
                return NAPI_INVALID_ARG;
            };
            unsafe { write(out, i32::from(($test)(value))) }.map_or_else(|e| e, |_| NAPI_OK)
        }
    };
}
type_test!(snapi_bridge_is_array, |v: &JsValue| Array::is_array(v));
type_test!(snapi_bridge_is_error, |v: &JsValue| v
    .is_instance_of::<Error>());
type_test!(snapi_bridge_is_arraybuffer, |v: &JsValue| {
    wasmer_napi_is_arraybuffer(v)
});
type_test!(
    snapi_bridge_is_typedarray,
    |v: &JsValue| wasmer_napi_typed_array_kind(v) >= 0
);
type_test!(snapi_bridge_is_dataview, |v: &JsValue| {
    wasmer_napi_is_dataview(v)
});
type_test!(snapi_bridge_is_date, |v: &JsValue| v
    .is_instance_of::<Date>());
type_test!(snapi_bridge_is_promise, |v: &JsValue| v
    .is_instance_of::<Promise>());
type_test!(snapi_bridge_is_buffer, |v: &JsValue| {
    wasmer_napi_is_buffer(v)
});

unsafe fn reflect_op(
    env: SnapiEnv,
    out: *mut u32,
    f: impl FnOnce(&mut HostJsEnv) -> Result<JsValue, JsValue>,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    match f(state) {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
        }
        Err(err) => {
            state.last_exception = Some(err);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_set_property(
    env: SnapiEnv,
    obj: u32,
    key: u32,
    value: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(obj), Some(key), Some(value)) = (state.get(obj), state.get(key), state.get(value))
    else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::set(obj, key, value) {
        Ok(_) => NAPI_OK,
        Err(e) => {
            state.last_exception = Some(e);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_property(
    env: SnapiEnv,
    obj: u32,
    key: u32,
    out: *mut u32,
) -> i32 {
    unsafe {
        reflect_op(env, out, |s| {
            Reflect::get(
                s.get(obj).ok_or(JsValue::NULL)?,
                s.get(key).ok_or(JsValue::NULL)?,
            )
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_set_named_property(
    env: SnapiEnv,
    obj: u32,
    name: *const i8,
    value: u32,
) -> i32 {
    let Ok(name) = (unsafe { cstr(name) }) else {
        return NAPI_INVALID_ARG;
    };
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(obj), Some(value)) = (state.get(obj), state.get(value)) else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::set(obj, &JsValue::from_str(&name), value) {
        Ok(_) => NAPI_OK,
        Err(e) => {
            state.last_exception = Some(e);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_named_property(
    env: SnapiEnv,
    obj: u32,
    name: *const i8,
    out: *mut u32,
) -> i32 {
    let Ok(name) = (unsafe { cstr(name) }) else {
        return NAPI_INVALID_ARG;
    };
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(obj) else {
        return NAPI_INVALID_ARG;
    };
    if !value.is_object() && !value.is_function() {
        return NAPI_OBJECT_EXPECTED;
    }
    unsafe {
        reflect_op(env, out, |s| {
            Reflect::get(s.get(obj).ok_or(JsValue::NULL)?, &JsValue::from_str(&name))
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_set_element(
    env: SnapiEnv,
    obj: u32,
    index: u32,
    value: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(obj), Some(value)) = (state.get(obj), state.get(value)) else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::set(obj, &JsValue::from_f64(index as f64), value) {
        Ok(_) => NAPI_OK,
        Err(e) => {
            state.last_exception = Some(e);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_element(
    env: SnapiEnv,
    obj: u32,
    index: u32,
    out: *mut u32,
) -> i32 {
    unsafe {
        reflect_op(env, out, |s| {
            Reflect::get(
                s.get(obj).ok_or(JsValue::NULL)?,
                &JsValue::from_f64(index as f64),
            )
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_array_length(
    env: SnapiEnv,
    id: u32,
    out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    if !Array::is_array(value) {
        return NAPI_OBJECT_EXPECTED;
    }
    unsafe { write(out, Array::from(value).length()) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_property_names(
    env: SnapiEnv,
    id: u32,
    out: *mut u32,
) -> i32 {
    unsafe {
        reflect_op(env, out, |s| {
            Ok(Object::keys(&Object::from(s.get(id).ok_or(JsValue::NULL)?.clone())).into())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_strict_equals(
    env: SnapiEnv,
    a: u32,
    b: u32,
    out: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(a), Some(b)) = (state.get(a), state.get(b)) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(out, i32::from(a == b)) }.map_or_else(|e| e, |_| NAPI_OK)
}

unsafe fn create_error(env: SnapiEnv, code: u32, message: u32, out: *mut u32, kind: u8) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let message = state
        .get(message)
        .and_then(|value| js_string(value).ok())
        .unwrap_or_default();
    let value: JsValue = match kind {
        1 => TypeError::new(&message).into(),
        2 => js_sys::RangeError::new(&message).into(),
        _ => Error::new(&message).into(),
    };
    if code != 0
        && let Some(code) = state.get(code)
    {
        let _ = Reflect::set(&value, &JsValue::from_str("code"), code);
    }
    let id = state.insert(value);
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_error(
    e: SnapiEnv,
    c: u32,
    m: u32,
    o: *mut u32,
) -> i32 {
    unsafe { create_error(e, c, m, o, 0) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_type_error(
    e: SnapiEnv,
    c: u32,
    m: u32,
    o: *mut u32,
) -> i32 {
    unsafe { create_error(e, c, m, o, 1) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_range_error(
    e: SnapiEnv,
    c: u32,
    m: u32,
    o: *mut u32,
) -> i32 {
    unsafe { create_error(e, c, m, o, 2) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_throw(env: SnapiEnv, id: u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    state.last_exception = Some(value);
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_is_exception_pending(env: SnapiEnv, out: *mut i32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(out, i32::from(state.last_exception.is_some())) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_and_clear_last_exception(
    env: SnapiEnv,
    out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let value = state.last_exception.take().unwrap_or(JsValue::UNDEFINED);
    let id = state.insert(value);
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_call_function(
    env: SnapiEnv,
    recv: u32,
    func: u32,
    argc: u32,
    argv: *const u32,
    out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(function) = state
        .get(func)
        .and_then(|v| v.dyn_ref::<Function>())
        .cloned()
    else {
        return NAPI_FUNCTION_EXPECTED;
    };
    let this = state.get(recv).cloned().unwrap_or(JsValue::UNDEFINED);
    let ids = if argv.is_null() && argc != 0 {
        return NAPI_INVALID_ARG;
    } else if argc == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(argv, argc as usize) }
    };
    let args = Array::new();
    for id in ids {
        let Some(value) = state.get(*id) else {
            return NAPI_INVALID_ARG;
        };
        args.push(value);
    }
    match function.apply(&this, &args) {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_new_instance(
    env: SnapiEnv,
    ctor: u32,
    argc: u32,
    argv: *const u32,
    out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(ctor) = state
        .get(ctor)
        .and_then(|v| v.dyn_ref::<Function>())
        .cloned()
    else {
        return NAPI_FUNCTION_EXPECTED;
    };
    let ids = if argv.is_null() && argc != 0 {
        return NAPI_INVALID_ARG;
    } else if argc == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(argv, argc as usize) }
    };
    let args = Array::new();
    for id in ids {
        let Some(v) = state.get(*id) else {
            return NAPI_INVALID_ARG;
        };
        args.push(v);
    }
    let value = wasmer_napi_new(&ctor, &args);
    let id = state.insert(value);
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_run_script(env: SnapiEnv, script: u32, out: *mut u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = state.get(script).and_then(JsValue::as_string) else {
        return NAPI_STRING_EXPECTED;
    };
    // napi_run_script executes in the environment's context. Evaluating with
    // js_sys::eval here would instead target the Wasmer worker's real global
    // realm, allowing Node bootstrap code from one N-API environment to mutate
    // the SDK scheduler and leak state into every other environment hosted by
    // that worker.
    let global = wasmer_napi_global_context_scope(&state.global_context);
    match wasmer_napi_context_eval(&global, &source) {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
        }
        Err(e) => {
            state.last_exception = Some(e);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_promise(
    env: SnapiEnv,
    deferred_out: *mut u32,
    out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let resolve_slot = std::rc::Rc::new(RefCell::new(None));
    let reject_slot = std::rc::Rc::new(RefCell::new(None));
    let rs = resolve_slot.clone();
    let rj = reject_slot.clone();
    let promise = Promise::new(&mut |resolve, reject| {
        *rs.borrow_mut() = Some(resolve);
        *rj.borrow_mut() = Some(reject);
    });
    let deferred = state.next_deferred;
    state.next_deferred = deferred.saturating_add(1);
    state.deferreds.insert(
        deferred,
        Deferred {
            resolve: resolve_slot.borrow_mut().take().unwrap(),
            reject: reject_slot.borrow_mut().take().unwrap(),
        },
    );
    let id = state.insert(promise.into());
    if unsafe { write(deferred_out, deferred) }.is_err() || unsafe { write(out, id) }.is_err() {
        NAPI_INVALID_ARG
    } else {
        NAPI_OK
    }
}

unsafe fn settle(env: SnapiEnv, deferred: u32, value: u32, reject: bool) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(d) = state.deferreds.remove(&deferred) else {
        return NAPI_INVALID_ARG;
    };
    let Some(v) = state.get(value) else {
        return NAPI_INVALID_ARG;
    };
    let result = if reject {
        d.reject.call1(&JsValue::UNDEFINED, v)
    } else {
        d.resolve.call1(&JsValue::UNDEFINED, v)
    };
    match result {
        Ok(_) => NAPI_OK,
        Err(e) => {
            state.last_exception = Some(e);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_resolve_deferred(e: SnapiEnv, d: u32, v: u32) -> i32 {
    unsafe { settle(e, d, v, false) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_reject_deferred(e: SnapiEnv, d: u32, v: u32) -> i32 {
    unsafe { settle(e, d, v, true) }
}

unsafe fn create_bytes_value(
    env: SnapiEnv,
    bytes: Vec<u8>,
    out: *mut u32,
    data_out: *mut u64,
) -> i32 {
    let array = Uint8Array::from(bytes.as_slice());
    let value = wasmer_napi_buffer_view(&array.buffer(), 0, array.length());
    if !data_out.is_null() {
        let host = store_bytes(bytes);
        unsafe { data_out.write(host) }
    }
    unsafe { put_value(env, out, value) }
}

pub(crate) fn create_guest_buffer_view(
    env: SnapiEnv,
    memory_buffer: &JsValue,
    byte_offset: u32,
    byte_length: u32,
    out: *mut u32,
) -> i32 {
    let view = wasmer_napi_buffer_view(memory_buffer, byte_offset, byte_length);
    unsafe { put_value(env, out, view) }
}

pub(crate) fn create_guest_typedarray_view(
    env: SnapiEnv,
    memory_buffer: &JsValue,
    typ: i32,
    byte_offset: u32,
    length: u32,
    out: *mut u32,
) -> i32 {
    match wasmer_napi_typed_array(typ, memory_buffer, byte_offset, length) {
        Ok(value) => unsafe { put_value(env, out, value) },
        Err(error) => {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_arraybuffer(e: SnapiEnv, n: u32, o: *mut u32) -> i32 {
    unsafe { put_value(e, o, ArrayBuffer::new(n).into()) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_buffer(
    e: SnapiEnv,
    n: u32,
    d: *mut u64,
    o: *mut u32,
) -> i32 {
    unsafe { create_bytes_value(e, vec![0; n as usize], o, d) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_buffer_copy(
    e: SnapiEnv,
    n: u32,
    s: *const u8,
    d: *mut u64,
    o: *mut u32,
) -> i32 {
    let Ok(b) = (unsafe { bytes(s, n as usize) }) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { create_bytes_value(e, b.to_vec(), o, d) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_snapshot_value_bytes(
    env: SnapiEnv,
    id: u32,
    data: *mut u64,
    len: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(bytes) = value_bytes(value) else {
        return NAPI_INVALID_ARG;
    };
    let n = bytes.len() as u32;
    let p = store_bytes(bytes);
    if unsafe { write(data, p) }.is_err() || unsafe { write(len, n) }.is_err() {
        NAPI_INVALID_ARG
    } else {
        NAPI_OK
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_overwrite_value_bytes(
    env: SnapiEnv,
    id: u32,
    data: *const c_void,
    len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let Ok(bytes) = (unsafe { bytes(data.cast(), len as usize) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(view) = value_byte_view(value) else {
        return NAPI_INVALID_ARG;
    };
    if len > view.length() {
        return NAPI_INVALID_ARG;
    }
    view.subarray(0, len).copy_from(bytes);
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_buffer_info(
    e: SnapiEnv,
    id: u32,
    d: *mut u64,
    l: *mut u32,
    t: *mut u64,
) -> i32 {
    let status = unsafe { snapi_bridge_snapshot_value_bytes(e, id, d, l) };
    if status == NAPI_OK && !t.is_null() {
        let token = unsafe { env_mut(e) }
            .ok()
            .and_then(|state| state.backing_store_token(id))
            .unwrap_or(id as u64);
        unsafe { t.write(token) }
    }
    status
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_backing_store_token(
    env: SnapiEnv,
    id: u32,
    token_out: *mut u64,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(token) = state.backing_store_token(id) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(token_out, token) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_arraybuffer_info(
    e: SnapiEnv,
    id: u32,
    d: *mut u64,
    l: *mut u32,
    t: *mut u64,
) -> i32 {
    unsafe { snapi_bridge_get_buffer_info(e, id, d, l, t) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_reference(
    env: SnapiEnv,
    value: u32,
    count: u32,
    out: *mut u32,
) -> i32 {
    let Ok(s) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = s.get(value).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let (strong, weak) = if count == 0 && (value.is_object() || value.is_function()) {
        let object: Object = value.unchecked_into();
        (None, Some(WeakRef::new(&object)))
    } else {
        (Some(value), None)
    };
    let id = s.next_reference;
    s.next_reference = id.saturating_add(1);
    s.references.insert(
        id,
        Reference {
            strong,
            weak,
            count,
        },
    );
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_delete_reference(e: SnapiEnv, id: u32) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    if s.references.remove(&id).is_some() {
        NAPI_OK
    } else {
        NAPI_INVALID_ARG
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_reference_ref(e: SnapiEnv, id: u32, o: *mut u32) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(r) = s.references.get_mut(&id) else {
        return NAPI_INVALID_ARG;
    };
    if r.count == 0 && r.strong.is_none() {
        r.strong = r.weak.as_ref().and_then(WeakRef::deref).map(Into::into);
        r.weak = None;
    }
    r.count = r.count.saturating_add(1);
    unsafe { write(o, r.count) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_reference_unref(e: SnapiEnv, id: u32, o: *mut u32) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(r) = s.references.get_mut(&id) else {
        return NAPI_INVALID_ARG;
    };
    r.count = r.count.saturating_sub(1);
    if r.count == 0
        && let Some(value) = r.strong.take()
    {
        if value.is_object() || value.is_function() {
            let object: Object = value.unchecked_into();
            r.weak = Some(WeakRef::new(&object));
        } else {
            // JavaScript cannot weak-reference primitives. Keeping the copied
            // scalar here does not retain an object graph.
            r.strong = Some(value);
        }
    }
    unsafe { write(o, r.count) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_reference_value(
    e: SnapiEnv,
    id: u32,
    o: *mut u32,
) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(r) = s.references.get(&id) else {
        return NAPI_INVALID_ARG;
    };
    let value = r
        .strong
        .clone()
        .or_else(|| r.weak.as_ref().and_then(WeakRef::deref).map(Into::into));
    let value_id = value.map(|value| s.insert(value)).unwrap_or(0);
    unsafe { write(o, value_id) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_overwrite_reference_bytes(
    env: SnapiEnv,
    reference_id: u32,
    data: *const c_void,
    len: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(reference) = state.references.get(&reference_id) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = reference.strong.clone().or_else(|| {
        reference
            .weak
            .as_ref()
            .and_then(WeakRef::deref)
            .map(Into::into)
    }) else {
        return NAPI_INVALID_ARG;
    };
    let Ok(bytes) = (unsafe { bytes(data.cast(), len as usize) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(view) = value_byte_view(&value) else {
        return NAPI_INVALID_ARG;
    };
    if len > view.length() {
        return NAPI_INVALID_ARG;
    }
    view.subarray(0, len).copy_from(bytes);
    NAPI_OK
}

unsafe extern "C" {
    fn snapi_host_invoke_wasm_callback(
        ctx: *mut c_void,
        guest_env: u32,
        wasm_fn: u32,
        arg: u32,
    ) -> u32;
    fn snapi_host_invoke_wasm_finalizer(
        ctx: *mut c_void,
        guest_env: u32,
        wasm_fn: u32,
        data: u32,
        hint: u32,
    ) -> u32;
}

unsafe fn drain_guest_finalizers(env: SnapiEnv, force: bool) -> i32 {
    loop {
        let (record, callback_ctx, value_frame) = {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let Some(record) = state.take_ready_guest_finalizer(force) else {
                return NAPI_OK;
            };
            let value_frame = state.open_value_frame();
            (record, state.active_callback_ctx, value_frame)
        };
        let result = unsafe {
            snapi_host_invoke_wasm_finalizer(
                callback_ctx,
                record.guest_env,
                record.wasm_fn_ptr,
                record.data,
                record.hint,
            )
        };
        let Ok(state) = (unsafe { env_mut(env) }) else {
            return NAPI_INVALID_ARG;
        };
        state.close_value_frame(value_frame);
        if result == CALLBACK_DEFERRED {
            state.guest_finalizers.push(record);
            return NAPI_OK;
        }
        if let Some(wrap_id) = record.wrap_id {
            state.wraps.remove(&wrap_id);
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_alloc_cb_reg_id(e: SnapiEnv) -> u32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return 0;
    };
    let id = s.next_callback;
    s.next_callback = id.saturating_add(1);
    id
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_register_callback(
    e: SnapiEnv,
    id: u32,
    g: u32,
    f: u32,
    d: u64,
) {
    if let Ok(s) = unsafe { env_mut(e) } {
        s.callback_regs.insert(
            id,
            CallbackReg {
                guest_env: g,
                wasm_fn_ptr: f,
                data: d,
            },
        );
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_swap_active_callback_ctx(
    e: SnapiEnv,
    c: *mut c_void,
) -> *mut c_void {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return ptr::null_mut();
    };
    std::mem::replace(&mut s.active_callback_ctx, c)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_function(
    env: SnapiEnv,
    name: *const i8,
    len: u32,
    reg: u32,
    out: *mut u32,
) -> i32 {
    let function_name = if name.is_null() {
        String::new()
    } else {
        let raw = unsafe { bytes_with_auto_length(name.cast(), len) }.unwrap_or_default();
        String::from_utf8_lossy(raw).into_owned()
    };
    let Ok(s) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(registration) = s.callback_regs.get(&reg).copied() else {
        return NAPI_INVALID_ARG;
    };
    let live_env_addr = s.live_env_addr.clone();
    let callback_name = function_name.clone();
    let closure = Closure::wrap(Box::new(move |this: JsValue, args: Array| -> JsValue {
        let env_addr = live_env_addr.get();
        if env_addr == 0 {
            wasmer_napi_console_error(&format!(
                "[wasmer-napi-callback] released env callback={callback_name}"
            ));
            return JsValue::UNDEFINED;
        }
        let env = env_addr as SnapiEnv;
        // Do not keep a mutable environment borrow across the guest callback:
        // invoking JavaScript from that callback may recursively enter this
        // same trampoline.
        let (value_frame, cb, callback_ctx) = {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                wasmer_napi_console_error(&format!(
                    "[wasmer-napi-callback] invalid env callback={callback_name}"
                ));
                return JsValue::UNDEFINED;
            };
            let value_frame = state.open_value_frame();
            let mut ids = Vec::with_capacity(args.length() as usize);
            for v in args.iter() {
                ids.push(state.insert(v));
            }
            let this_value = state.insert(this);
            let cb = state.next_cbinfo;
            state.next_cbinfo = cb.saturating_add(1);
            state.callback_infos.insert(
                cb,
                CallbackInfo {
                    args: ids,
                    this_value,
                    data: registration.data,
                },
            );
            (value_frame, cb, state.active_callback_ctx)
        };
        if callback_ctx.is_null() {
            wasmer_napi_console_error(&format!(
                "[wasmer-napi-callback] missing context callback={callback_name}"
            ));
        }
        let result = unsafe {
            snapi_host_invoke_wasm_callback(
                callback_ctx,
                registration.guest_env,
                registration.wasm_fn_ptr,
                cb,
            )
        };
        if result == CALLBACK_DEFERRED {
            let resolve_slot = Rc::new(RefCell::new(None));
            let reject_slot = Rc::new(RefCell::new(None));
            let rs = resolve_slot.clone();
            let rj = reject_slot.clone();
            let promise = Promise::new(&mut |resolve, reject| {
                *rs.borrow_mut() = Some(resolve);
                *rj.borrow_mut() = Some(reject);
            });
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return JsValue::UNDEFINED;
            };
            state.pending_callbacks.push_back(PendingCallback {
                registration,
                cbinfo: cb,
                value_frame,
                resolve: resolve_slot.borrow_mut().take().unwrap(),
                reject: reject_slot.borrow_mut().take().unwrap(),
            });
            return promise.into();
        }
        let Ok(state) = (unsafe { env_mut(env) }) else {
            return JsValue::UNDEFINED;
        };
        let error = state.last_exception.take();
        let result_value = state.get(result).cloned();
        if result_value.is_none() && result != 0 {
            wasmer_napi_console_error(&format!(
                "[wasmer-napi-callback] invalid result callback={callback_name} handle={result} guest_env={} wasm_fn={} value_slots={} free_slots={} scope_depth={}",
                registration.guest_env,
                registration.wasm_fn_ptr,
                state.values.len(),
                state.value_free_slots.len(),
                state.value_frames.len(),
            ));
        }
        let result = result_value.unwrap_or(JsValue::UNDEFINED);
        state.callback_infos.remove(&cb);
        state.close_value_frame(value_frame);
        if let Some(error) = error {
            wasm_bindgen::throw_val(error);
        }
        result
    }) as Box<dyn Fn(JsValue, Array) -> JsValue>);
    let function = wasmer_napi_make_callback(closure.as_ref().unchecked_ref());
    if !name.is_null() {
        let _ = Reflect::set(
            &function,
            &JsValue::from_str("displayName"),
            &JsValue::from_str(&function_name),
        );
    }
    s.closures.push(closure);
    let id = s.insert(function.into());
    unsafe { write(out, id) }.map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_drain_pending_callbacks(env: SnapiEnv) -> i32 {
    loop {
        let (pending, callback_ctx) = {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let Some(pending) = state.pending_callbacks.pop_front() else {
                return unsafe { drain_guest_finalizers(env, false) };
            };
            (pending, state.active_callback_ctx)
        };

        let result = unsafe {
            snapi_host_invoke_wasm_callback(
                callback_ctx,
                pending.registration.guest_env,
                pending.registration.wasm_fn_ptr,
                pending.cbinfo,
            )
        };
        if result == CALLBACK_DEFERRED {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            state.pending_callbacks.push_front(pending);
            return NAPI_OK;
        }

        let (error, result) = {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let error = state.last_exception.take();
            let result = state.get(result).cloned().unwrap_or(JsValue::UNDEFINED);
            state.callback_infos.remove(&pending.cbinfo);
            state.close_value_frame(pending.value_frame);
            (error, result)
        };
        let settled = if let Some(error) = error {
            pending.reject.call1(&JsValue::UNDEFINED, &error)
        } else {
            pending.resolve.call1(&JsValue::UNDEFINED, &result)
        };
        if let Err(error) = settled {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            state.last_exception = Some(error);
            return NAPI_PENDING_EXCEPTION;
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_drain_all_guest_finalizers(env: SnapiEnv) -> i32 {
    unsafe { drain_guest_finalizers(env, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_register_guest_buffer_finalizer(
    env: SnapiEnv,
    value_id: u32,
    guest_ptr: u32,
    recyclable: i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(value_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    if !value.is_object() && !value.is_function() {
        return NAPI_INVALID_ARG;
    }
    state.guest_buffer_finalizers.push(GuestBufferFinalizer {
        target: WeakRef::new(&value.unchecked_into::<Object>()),
        handle_id: value_id,
        guest_ptr,
        recyclable: recyclable != 0,
    });
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_take_ready_guest_buffer_finalizer(
    env: SnapiEnv,
    force: i32,
    handle_id_out: *mut u32,
    guest_ptr_out: *mut u32,
    recyclable_out: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(record) = state.take_ready_guest_buffer_finalizer(force != 0) else {
        return 1;
    };
    if unsafe { write(handle_id_out, record.handle_id) }.is_err()
        || unsafe { write(guest_ptr_out, record.guest_ptr) }.is_err()
        || unsafe { write(recyclable_out, i32::from(record.recyclable)) }.is_err()
    {
        return NAPI_INVALID_ARG;
    }
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_cb_info(
    e: SnapiEnv,
    id: u32,
    argc: *mut u32,
    argv: *mut u32,
    max: u32,
    this_out: *mut u32,
    data: *mut u64,
) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(info) = s.callback_infos.get(&id) else {
        return NAPI_INVALID_ARG;
    };
    let requested = if argc.is_null() {
        max
    } else {
        unsafe { argc.read() }.min(max)
    };
    let n = (info.args.len() as u32).min(requested);
    if !argv.is_null() {
        unsafe { ptr::copy_nonoverlapping(info.args.as_ptr(), argv, n as usize) }
    }
    if !argc.is_null() {
        unsafe { argc.write(n) }
    }
    if !this_out.is_null() {
        unsafe { this_out.write(info.this_value) }
    }
    if !data.is_null() {
        unsafe { data.write(info.data) }
    }
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_set_instance_data(e: SnapiEnv, d: u64) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    s.instance_data = d;
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_instance_data(e: SnapiEnv, d: *mut u64) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(d, s.instance_data) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_wrap(e: SnapiEnv, o: u32, d: u64, r: *mut u32) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(wrap_id) = s.wrap_id(o, true) else {
        return NAPI_INVALID_ARG;
    };
    s.wraps.insert(wrap_id, d);
    if r.is_null() {
        NAPI_OK
    } else {
        unsafe { snapi_bridge_create_reference(e, o, 0, r) }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unwrap(e: SnapiEnv, o: u32, d: *mut u64) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(wrap_id) = s.wrap_id(o, false) else {
        return NAPI_INVALID_ARG;
    };
    let Some(v) = s.wraps.get(&wrap_id).copied() else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(d, v) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_remove_wrap(e: SnapiEnv, o: u32, d: *mut u64) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(wrap_id) = s.wrap_id(o, false) else {
        return NAPI_INVALID_ARG;
    };
    let Some(v) = s.wraps.remove(&wrap_id) else {
        return NAPI_INVALID_ARG;
    };
    s.guest_finalizers
        .retain(|record| record.wrap_id != Some(wrap_id));
    unsafe { write(d, v) }.map_or_else(|e| e, |_| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_type_tag_object(e: SnapiEnv, o: u32, l: u64, u: u64) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    s.type_tags.insert(o, (l, u));
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_check_object_type_tag(
    e: SnapiEnv,
    o: u32,
    l: u64,
    u: u64,
    r: *mut i32,
) -> i32 {
    let Ok(s) = (unsafe { env_mut(e) }) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(r, i32::from(s.type_tags.get(&o) == Some(&(l, u)))) }
        .map_or_else(|e| e, |_| NAPI_OK)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_event_loop_checkpoint(
    _env: SnapiEnv,
    _mode: i32,
    _has_runnable_work: i32,
    checkpoint_state: *mut u32,
) -> i32 {
    if has_jspi() {
        let _ = unsafe {
            write(
                checkpoint_state,
                u32::from(wasmer_napi_has_pending_provider_work()),
            )
        };
        NAPI_OK
    } else {
        NAPI_GENERIC_FAILURE
    }
}
// ABI-complete placeholders. These deliberately return napi_generic_failure
// until their host-JS semantics are implemented; keeping the symbols local
// prevents wasm-bindgen output from acquiring raw C imports.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_collect_garbage(env: SnapiEnv) -> i32 {
    let _ = env;
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_set_prepare_stack_trace_callback(
    env: SnapiEnv,
    callback_id: u32,
) -> i32 {
    let _ = (env, callback_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_cancel_terminate_execution(env: SnapiEnv) -> i32 {
    let _ = env;
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_request_interrupt(
    env: SnapiEnv,
    guest_env: u32,
    wasm_fn_ptr: u32,
    data: u32,
) -> i32 {
    let _ = (env, guest_env, wasm_fn_ptr, data);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_set_promise_hooks(
    env: SnapiEnv,
    init_callback_id: u32,
    before_callback_id: u32,
    after_callback_id: u32,
    resolve_callback_id: u32,
) -> i32 {
    let _ = (
        env,
        init_callback_id,
        before_callback_id,
        after_callback_id,
        resolve_callback_id,
    );
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_promise_details(
    env: SnapiEnv,
    promise_id: u32,
    state_out: *mut i32,
    result_out: *mut u32,
    has_result_out: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(promise) = state.get(promise_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    if !promise.is_instance_of::<Promise>() {
        return NAPI_INVALID_ARG;
    }
    let details = wasmer_napi_get_promise_details(&promise);
    let promise_state = details.get(0).as_f64().unwrap_or(0.0) as i32;
    let has_result = details.get(2).as_bool().unwrap_or(false);
    if !state_out.is_null() && unsafe { write(state_out, promise_state) }.is_err() {
        return NAPI_INVALID_ARG;
    }
    if !has_result_out.is_null() && unsafe { write(has_result_out, i32::from(has_result)) }.is_err()
    {
        return NAPI_INVALID_ARG;
    }
    if has_result && !result_out.is_null() {
        let result_id = state.insert(details.get(1));
        if unsafe { write(result_out, result_id) }.is_err() {
            return NAPI_INVALID_ARG;
        }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_proxy_details(
    env: SnapiEnv,
    proxy_id: u32,
    target_out: *mut u32,
    handler_out: *mut u32,
) -> i32 {
    let _ = (env, proxy_id, target_out, handler_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_preview_entries(
    env: SnapiEnv,
    value_id: u32,
    entries_out: *mut u32,
    is_key_value_out: *mut i32,
) -> i32 {
    let _ = (env, value_id, entries_out, is_key_value_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_call_sites(
    env: SnapiEnv,
    frames: u32,
    callsites_out: *mut u32,
) -> i32 {
    let _ = (env, frames, callsites_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_arraybuffer_view_has_buffer(
    env: SnapiEnv,
    value_id: u32,
    result_out: *mut i32,
) -> i32 {
    let _ = (env, value_id, result_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_constructor_name(
    env: SnapiEnv,
    value_id: u32,
    name_out: *mut u32,
) -> i32 {
    let _ = (env, value_id, name_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_create_private_symbol(
    env: SnapiEnv,
    str_ptr: *const i8,
    wasm_length: u32,
    out_id: *mut u32,
) -> i32 {
    let description = if str_ptr.is_null() {
        JsValue::UNDEFINED
    } else {
        let Ok(raw) = (unsafe { bytes_with_auto_length(str_ptr.cast(), wasm_length) }) else {
            return NAPI_INVALID_ARG;
        };
        JsValue::from_str(&String::from_utf8_lossy(raw))
    };
    unsafe { put_value(env, out_id, wasmer_napi_symbol(&description)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_continuation_preserved_embedder_data(
    env: SnapiEnv,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, out_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_set_continuation_preserved_embedder_data(
    env: SnapiEnv,
    value_id: u32,
) -> i32 {
    let _ = (env, value_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_attach_env(
    env: SnapiEnv,
    fatal_callback_id: u32,
    oom_callback_id: u32,
    accepted_hooks_out: *mut u64,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.embedder_hooks_attached || accepted_hooks_out.is_null() {
        return NAPI_INVALID_ARG;
    }
    let _ = (fatal_callback_id, oom_callback_id);
    // JavaScript-hosted execution already runs on the host event loop, and the
    // browser/Node host owns fatal JavaScript and OOM handling. Accept the same
    // single attachment transition while reporting that no guest callback can
    // be invoked as a native provider function pointer.
    state.embedder_hooks_attached = true;
    unsafe { accepted_hooks_out.write(0) };
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_terminate_execution(env: SnapiEnv) -> i32 {
    let _ = env;
    NAPI_GENERIC_FAILURE
}
// iwci patch: the host terminate entry point, as in napi_bridge_init.cc.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_host_terminate_execution(env: SnapiEnv) -> i32 {
    unsafe { snapi_bridge_unofficial_terminate_execution(env) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_enqueue_microtask(
    env: SnapiEnv,
    callback_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(callback) = state
        .get(callback_id)
        .and_then(|value| value.dyn_ref::<Function>())
        .cloned()
    else {
        return NAPI_FUNCTION_EXPECTED;
    };
    wasmer_napi_enqueue_microtask(&callback);
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_set_promise_reject_callback(
    env: SnapiEnv,
    callback_id: u32,
) -> i32 {
    let _ = (env, callback_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_own_non_index_properties(
    env: SnapiEnv,
    value_id: u32,
    filter_bits: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(value_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    if !value.is_object() && !value.is_function() {
        return NAPI_OBJECT_EXPECTED;
    }

    let object = Object::from(value);
    let keys = match Reflect::own_keys(&object) {
        Ok(keys) => keys,
        Err(error) => {
            state.last_exception = Some(error);
            return NAPI_PENDING_EXCEPTION;
        }
    };
    let filtered = Array::new();
    for key in keys.iter() {
        if key.is_symbol() {
            if filter_bits & 16 != 0 {
                continue;
            }
        } else if let Some(text) = key.as_string() {
            if filter_bits & 8 != 0 || is_array_index_key(&text) {
                continue;
            }
        } else {
            continue;
        }

        if filter_bits & 7 != 0 {
            let descriptor = match Reflect::get_own_property_descriptor(&object, &key) {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    state.last_exception = Some(error);
                    return NAPI_PENDING_EXCEPTION;
                }
            };
            if descriptor.is_undefined() {
                continue;
            }
            if filter_bits & 1 != 0
                && Reflect::get(&descriptor, &JsValue::from_str("writable"))
                    .ok()
                    .and_then(|value| value.as_bool())
                    == Some(false)
            {
                continue;
            }
            if filter_bits & 2 != 0
                && !Reflect::get(&descriptor, &JsValue::from_str("enumerable"))
                    .is_ok_and(|value| value.is_truthy())
            {
                continue;
            }
            if filter_bits & 4 != 0
                && !Reflect::get(&descriptor, &JsValue::from_str("configurable"))
                    .is_ok_and(|value| value.is_truthy())
            {
                continue;
            }
        }
        filtered.push(&key);
    }

    let id = state.insert(filtered.into());
    unsafe { write(out_id, id) }.map_or_else(|error| error, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_hash_seed(
    env: SnapiEnv,
    hash_seed_out: *mut u64,
) -> i32 {
    let _ = (env, hash_seed_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_error_metadata(
    env: SnapiEnv,
    error_id: u32,
    mode: i32,
    source_line_out: *mut u32,
    script_resource_name_out: *mut u32,
    stderr_line_out: *mut u32,
    thrown_at_out: *mut u32,
    line_number_out: *mut i32,
    start_column_out: *mut i32,
    end_column_out: *mut i32,
) -> i32 {
    let _ = (
        env,
        error_id,
        mode,
        source_line_out,
        script_resource_name_out,
        stderr_line_out,
        thrown_at_out,
        line_number_out,
        start_column_out,
        end_column_out,
    );
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_configure_source_maps(
    env: SnapiEnv,
    enabled: i32,
    callback_id: u32,
) -> i32 {
    let _ = (env, enabled, callback_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_preserve_error_source_message(
    env: SnapiEnv,
    error_id: u32,
) -> i32 {
    let _ = (env, error_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_mark_promise_as_handled(
    env: SnapiEnv,
    promise_id: u32,
) -> i32 {
    let _ = (env, promise_id);
    NAPI_GENERIC_FAILURE
}

fn host_heap_sizes() -> (u64, u64, u64, bool) {
    fn metric(memory: &JsValue, name: &str) -> u64 {
        Reflect::get(memory, &JsValue::from_str(name))
            .ok()
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.min(u64::MAX as f64) as u64)
            .unwrap_or(0)
    }

    let global = js_sys::global();
    let memory = Reflect::get(&global, &JsValue::from_str("performance"))
        .ok()
        .and_then(|performance| Reflect::get(&performance, &JsValue::from_str("memory")).ok())
        .unwrap_or(JsValue::UNDEFINED);
    let used = metric(&memory, "usedJSHeapSize");
    let total = metric(&memory, "totalJSHeapSize").max(used);
    // `performance.memory` is Chromium-specific. When the host does not expose
    // it, report an unknown-but-nonzero ceiling instead of zero: Node consumers
    // interpret zero as an exhausted heap and may terminate healthy workers.
    let limit = metric(&memory, "jsHeapSizeLimit")
        .max(total)
        .max(u64::from(u32::MAX));
    (
        total,
        used,
        limit,
        !memory.is_undefined() && !memory.is_null(),
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_heap_statistics(
    env: SnapiEnv,
    stats_out: *mut SnapiUnofficialHeapStatistics,
) -> i32 {
    if stats_out.is_null() || (unsafe { env_mut(env) }).is_err() {
        return NAPI_INVALID_ARG;
    }
    let requested = unsafe { &*stats_out };
    if requested.size < std::mem::size_of::<SnapiUnofficialHeapStatistics>() as u32
        || requested.version != 1
    {
        return NAPI_INVALID_ARG;
    }
    let output_size = requested.size;
    let (total, used, limit, measured) = host_heap_sizes();
    unsafe {
        ptr::write(
            stats_out,
            SnapiUnofficialHeapStatistics {
                size: output_size,
                version: 1,
                // The conservative ceiling is intentionally available even
                // when Chromium withholds `performance.memory`. Only mark the
                // host measurements valid when the host actually supplied
                // them, but always expose the nonzero ceiling we computed.
                valid_fields: (1 << 5)
                    | if measured {
                        (1 << 0) | (1 << 3) | (1 << 4)
                    } else {
                        0
                    },
                total_heap_size: total,
                total_heap_size_executable: 0,
                total_physical_size: 0,
                total_available_size: limit.saturating_sub(used),
                used_heap_size: used,
                heap_size_limit: limit,
                does_zap_garbage: 0,
                malloced_memory: 0,
                peak_malloced_memory: 0,
                number_of_native_contexts: 0,
                number_of_detached_contexts: 0,
                total_global_handles_size: 0,
                used_global_handles_size: 0,
                external_memory: 0,
                array_buffer_memory: 0,
            },
        );
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_heap_space_statistics(
    env: SnapiEnv,
    stats_out: *mut SnapiUnofficialHeapSpaceStatistics,
    capacity: u32,
    count_out: *mut u32,
) -> i32 {
    if count_out.is_null()
        || (capacity > 0 && stats_out.is_null())
        || (unsafe { env_mut(env) }).is_err()
    {
        return NAPI_INVALID_ARG;
    }
    unsafe { ptr::write(count_out, 1) };
    if capacity == 0 {
        return NAPI_OK;
    }

    let (total, used, limit, _) = host_heap_sizes();
    let mut space_name = [0; 64];
    space_name[.."host_js".len()].copy_from_slice(b"host_js");
    unsafe {
        ptr::write(
            stats_out,
            SnapiUnofficialHeapSpaceStatistics {
                space_name,
                space_size: total,
                space_used_size: used,
                space_available_size: limit.saturating_sub(used),
                physical_space_size: total,
            },
        );
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_get_heap_code_statistics(
    env: SnapiEnv,
    stats_out: *mut SnapiUnofficialHeapCodeStatistics,
) -> i32 {
    if stats_out.is_null() || (unsafe { env_mut(env) }).is_err() {
        return NAPI_INVALID_ARG;
    }
    unsafe {
        ptr::write(
            stats_out,
            SnapiUnofficialHeapCodeStatistics {
                code_and_metadata_size: 0,
                bytecode_and_metadata_size: 0,
                external_script_source_size: 0,
                cpu_profiler_metadata_size: 0,
            },
        );
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_profile_start(
    env: SnapiEnv,
    kind: i32,
    result_out: *mut i32,
    profile_out: *mut u32,
) -> i32 {
    let _ = (env, kind, result_out, profile_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_profile_stop(
    env: SnapiEnv,
    profile: u32,
    json_out: *mut u32,
) -> i32 {
    let _ = (env, profile, json_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_take_heap_snapshot(
    env: SnapiEnv,
    expose_internals: i32,
    expose_numeric_values: i32,
    json_out: *mut u32,
) -> i32 {
    let _ = (env, expose_internals, expose_numeric_values, json_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_structured_clone(
    env: SnapiEnv,
    value_id: u32,
    transfer_list_id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(value_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let transfer_list = if transfer_list_id == 0 {
        JsValue::UNDEFINED
    } else if let Some(value) = state.get(transfer_list_id).cloned() {
        value
    } else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_structured_clone(&value, &transfer_list) {
        Ok(cloned) => {
            let id = state.insert(cloned);
            unsafe { write(out_id, id) }.map_or_else(|error| error, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_message_create(
    env: SnapiEnv,
    value_id: u32,
    payload_out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(value_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let Some(payload) = next_serialized_message(wasmer_napi_message_scope()) else {
        return NAPI_GENERIC_FAILURE;
    };
    match wasmer_napi_share_message(&value, payload) {
        Ok(_) => match unsafe { write(payload_out, payload) } {
            Ok(()) => NAPI_OK,
            Err(error) => {
                wasmer_napi_release_message(payload);
                error
            }
        },
        Err(error) => {
            wasmer_napi_release_message(payload);
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_message_take(
    env: SnapiEnv,
    payload: u32,
    value_out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        wasmer_napi_release_message(payload);
        return NAPI_INVALID_ARG;
    };
    let obtained = wasmer_napi_obtain_message(payload);
    wasmer_napi_release_message(payload);
    match obtained {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(value_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn snapi_bridge_unofficial_message_drop(payload: u32) {
    wasmer_napi_release_message(payload);
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_notify_datetime_configuration_change(
    env: SnapiEnv,
) -> i32 {
    let _ = env;
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_create_serdes_binding(
    env: SnapiEnv,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_create_serdes_binding() {
        Ok(binding) => {
            let id = state.insert(binding);
            unsafe { write(out_id, id) }.map_or_else(|error| error, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_contextify_contains_module_syntax(
    env: SnapiEnv,
    code_id: u32,
    filename_id: u32,
    resource_name_id: u32,
    cjs_var_in_scope: i32,
    result_out: *mut i32,
) -> i32 {
    let _ = (filename_id, resource_name_id);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = state.get(code_id).and_then(JsValue::as_string) else {
        return NAPI_STRING_EXPECTED;
    };
    let params = Array::new();
    if cjs_var_in_scope != 0 {
        for name in ["exports", "require", "module", "__filename", "__dirname"] {
            params.push(&JsValue::from_str(name));
        }
    }
    let scope = wasmer_napi_global_context_scope(&state.global_context);
    let context_extensions = Array::new();
    let is_module = wasmer_napi_compile_function(&scope, &context_extensions, &params, &source, "")
        .is_err()
        && source.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("import ")
                || line.starts_with("import{")
                || line.starts_with("export ")
                || line.starts_with("export{")
        });
    unsafe { write(result_out, i32::from(is_module)) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_contextify_make_context(
    env: SnapiEnv,
    sandbox_or_symbol_id: u32,
    name_id: u32,
    origin_id: u32,
    allow_code_gen_strings: i32,
    allow_code_gen_wasm: i32,
    own_microtask_queue: i32,
    host_defined_option_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (
        name_id,
        origin_id,
        allow_code_gen_strings,
        allow_code_gen_wasm,
        own_microtask_queue,
        host_defined_option_id,
    );
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let sandbox = if sandbox_or_symbol_id == 0 {
        Object::new().into()
    } else {
        state
            .get(sandbox_or_symbol_id)
            .cloned()
            .unwrap_or_else(|| Object::new().into())
    };
    let _ = Reflect::set(&sandbox, &JsValue::from_str("global"), &sandbox);
    let _ = Reflect::set(&sandbox, &JsValue::from_str("globalThis"), &sandbox);
    let id = state.insert(sandbox);
    unsafe { write(result_out, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_contextify_run_script(
    env: SnapiEnv,
    sandbox_or_null_id: u32,
    source_text_id: u32,
    source_bytecode_id: u32,
    filename_id: u32,
    line_offset: i32,
    column_offset: i32,
    timeout: i64,
    display_errors: i32,
    break_on_sigint: i32,
    break_on_first_line: i32,
    host_defined_option_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (
        source_bytecode_id,
        filename_id,
        line_offset,
        column_offset,
        timeout,
        display_errors,
        break_on_sigint,
        break_on_first_line,
        host_defined_option_id,
    );
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let source = match host_js_source_for_shape(state, source_text_id, source_bytecode_id, 0) {
        Ok(source) => source,
        Err(status) => return status,
    };
    let sandbox = state
        .get(sandbox_or_null_id)
        .cloned()
        .unwrap_or(JsValue::NULL);
    match wasmer_napi_context_eval(&sandbox, &source) {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(result_out, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_contextify_compile_function(
    env: SnapiEnv,
    source_text_id: u32,
    source_bytecode_id: u32,
    filename_id: u32,
    line_offset: i32,
    column_offset: i32,
    parsing_context_id: u32,
    context_extensions_id: u32,
    params_id: u32,
    host_defined_option_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (line_offset, column_offset, host_defined_option_id);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let source = match host_js_source_for_shape(state, source_text_id, source_bytecode_id, 1) {
        Ok(source) => source,
        Err(status) => return status,
    };
    let params = Array::new();
    if let Some(values) = state.get(params_id).filter(|value| Array::is_array(value)) {
        for value in Array::from(values).iter() {
            match js_string(&value) {
                Ok(value) => {
                    params.push(&JsValue::from_str(&value));
                }
                Err(error) => {
                    state.last_exception = Some(error);
                    return NAPI_PENDING_EXCEPTION;
                }
            }
        }
    }
    let filename = state
        .get(filename_id)
        .and_then(JsValue::as_string)
        .unwrap_or_default();
    let scope = match evaluation_scope(state, parsing_context_id) {
        Ok(scope) => scope,
        Err(status) => return status,
    };
    let context_extensions = if context_extensions_id == 0 {
        Array::new()
    } else if let Some(value) = state.get(context_extensions_id) {
        if value.is_null() || value.is_undefined() {
            Array::new()
        } else if Array::is_array(value) {
            Array::from(value)
        } else {
            return NAPI_ARRAY_EXPECTED;
        }
    } else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_compile_function(&scope, &context_extensions, &params, &source, &filename) {
        Ok(function) => {
            let result = Object::new();
            let _ = Reflect::set(
                &result,
                &JsValue::from_str("cachedDataRejected"),
                &JsValue::FALSE,
            );
            let _ = Reflect::set(
                &result,
                &JsValue::from_str("canParseAsESM"),
                &JsValue::FALSE,
            );
            let _ = Reflect::set(
                &result,
                &JsValue::from_str("sourceMapURL"),
                &JsValue::UNDEFINED,
            );
            let source_url = state
                .get(filename_id)
                .cloned()
                .unwrap_or(JsValue::UNDEFINED);
            let _ = Reflect::set(&result, &JsValue::from_str("sourceURL"), &source_url);
            let _ = Reflect::set(&result, &JsValue::from_str("function"), function.as_ref());
            let id = state.insert(result.into());
            unsafe { write(result_out, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_bytecode_open(
    env: SnapiEnv,
    source_text_id: u32,
    filename_id: u32,
    shape: i32,
    params_id: u32,
    host_defined_option_id: u32,
    line_offset: i32,
    column_offset: i32,
    cache_bytes: *const u8,
    cache_byte_length: usize,
    has_cache: u8,
    cache_policy: u8,
    bytecode_out: *mut u32,
    cache_rejected_out: *mut u8,
    can_parse_as_module_out: *mut u8,
) -> i32 {
    let _ = (host_defined_option_id, line_offset, column_offset);
    let _ = (cache_bytes, cache_byte_length);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(source_value) = state.get(source_text_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let Some(source) = source_value.as_string() else {
        return NAPI_STRING_EXPECTED;
    };
    if cache_policy > 1 {
        return NAPI_INVALID_ARG;
    }
    if has_cache != 0 && cache_policy == 1 {
        let _ = unsafe { write(bytecode_out, 0) };
        let _ = unsafe { write(cache_rejected_out, 1) };
        let _ = unsafe { write(can_parse_as_module_out, 0) };
        return NAPI_OK;
    }
    let filename = state
        .get(filename_id)
        .and_then(JsValue::as_string)
        .unwrap_or_default();
    let params = Array::new();
    if params_id != 0 {
        let Some(values) = state.get(params_id).filter(|value| Array::is_array(value)) else {
            return NAPI_ARRAY_EXPECTED;
        };
        for value in Array::from(values).iter() {
            match js_string(&value) {
                Ok(value) => {
                    params.push(&JsValue::from_str(&value));
                }
                Err(error) => {
                    state.last_exception = Some(error);
                    return NAPI_PENDING_EXCEPTION;
                }
            }
        }
    }
    let scope = wasmer_napi_global_context_scope(&state.global_context);
    let context_extensions = Array::new();
    let compile_result = match shape {
        0 => wasmer_napi_validate_script(&source, &filename),
        1 => wasmer_napi_compile_function(&scope, &context_extensions, &params, &source, &filename)
            .map(|_| ()),
        2 => wasmer_napi_compile_module(&scope, &source, &filename).map(|_| ()),
        _ => return NAPI_INVALID_ARG,
    };
    if let Err(error) = compile_result {
        let can_parse_as_module =
            shape != 2 && wasmer_napi_compile_module(&scope, &source, &filename).is_ok();
        let _ = unsafe { write(cache_rejected_out, has_cache) };
        let _ = unsafe { write(can_parse_as_module_out, u8::from(can_parse_as_module)) };
        state.last_exception = Some(error);
        return NAPI_PENDING_EXCEPTION;
    }

    let bytecode = state.next_bytecode.max(1);
    state.next_bytecode = bytecode.wrapping_add(1).max(1);
    state.bytecodes.insert(
        bytecode,
        HostJsBytecode {
            source: source_value,
            shape,
        },
    );
    if let Err(error) = unsafe { write(bytecode_out, bytecode) } {
        state.bytecodes.remove(&bytecode);
        return error;
    }
    if let Err(error) = unsafe { write(cache_rejected_out, has_cache) } {
        state.bytecodes.remove(&bytecode);
        return error;
    }
    if let Err(error) = unsafe { write(can_parse_as_module_out, 0) } {
        state.bytecodes.remove(&bytecode);
        return error;
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_bytecode_serialize(
    env: SnapiEnv,
    bytecode_id: u32,
    buffer_out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if !state.bytecodes.contains_key(&bytecode_id) {
        return NAPI_INVALID_ARG;
    }
    let id = state.insert(Uint8Array::new_with_length(0).into());
    unsafe { write(buffer_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_bytecode_release(
    env: SnapiEnv,
    bytecode_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.bytecodes.remove(&bytecode_id).is_some() {
        NAPI_OK
    } else {
        NAPI_INVALID_ARG
    }
}
unsafe fn host_js_create_source_text_module(
    env: SnapiEnv,
    wrapper_id: u32,
    url_id: u32,
    context_id: u32,
    source_text_id: u32,
    source_bytecode_id: u32,
    line_offset: i32,
    column_offset: i32,
    host_defined_option_id: u32,
    handle_out: *mut u32,
    requests_out: *mut u32,
    has_top_level_await_out: *mut u8,
) -> i32 {
    let _ = (line_offset, column_offset, host_defined_option_id);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.get(wrapper_id).is_none() {
        return NAPI_INVALID_ARG;
    }
    let Some(url) = state.get(url_id).and_then(JsValue::as_string) else {
        return NAPI_STRING_EXPECTED;
    };
    let source = match host_js_source_for_shape(state, source_text_id, source_bytecode_id, 2) {
        Ok(source) => source,
        Err(status) => return status,
    };

    let scope = match evaluation_scope(state, context_id) {
        Ok(scope) => scope,
        Err(status) => return status,
    };
    let compiled = match wasmer_napi_compile_module(&scope, &source, &url) {
        Ok(value) => value,
        Err(error) => {
            state.last_exception = Some(error);
            return NAPI_PENDING_EXCEPTION;
        }
    };
    let Ok(requests_value) = Reflect::get(&compiled, &JsValue::from_str("requests")) else {
        return NAPI_GENERIC_FAILURE;
    };
    if !Array::is_array(&requests_value) {
        return NAPI_GENERIC_FAILURE;
    }
    let requests = Array::from(&requests_value);
    let Ok(export_names_value) = Reflect::get(&compiled, &JsValue::from_str("exportNames")) else {
        return NAPI_GENERIC_FAILURE;
    };
    if !Array::is_array(&export_names_value) {
        return NAPI_GENERIC_FAILURE;
    }
    let Ok(execute_value) = Reflect::get(&compiled, &JsValue::from_str("execute")) else {
        return NAPI_GENERIC_FAILURE;
    };
    let Some(execute) = execute_value.dyn_ref::<Function>().cloned() else {
        return NAPI_FUNCTION_EXPECTED;
    };
    let has_top_level_await = Reflect::get(&compiled, &JsValue::from_str("hasTopLevelAwait"))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let namespace = Object::new();
    for name_value in Array::from(&export_names_value).iter() {
        let Some(name) = name_value.as_string() else {
            return NAPI_STRING_EXPECTED;
        };
        if Reflect::set(&namespace, &JsValue::from_str(&name), &JsValue::UNDEFINED).is_err() {
            return NAPI_GENERIC_FAILURE;
        }
    }

    let handle = state.next_module;
    state.next_module = state.next_module.wrapping_add(1).max(1);
    let requests_id = state.insert(requests.clone().into());
    state.source_text_modules.insert(
        handle,
        SourceTextModule {
            url,
            requests,
            linked_handles: Vec::new(),
            execute,
            namespace,
            has_top_level_await,
            status: 0,
            error: None,
            evaluation: None,
        },
    );
    for result in [
        unsafe { write(handle_out, handle) },
        unsafe { write(requests_out, requests_id) },
        unsafe { write(has_top_level_await_out, u8::from(has_top_level_await)) },
    ] {
        if let Err(error) = result {
            return error;
        }
    }
    NAPI_OK
}
unsafe fn host_js_create_synthetic_module(
    env: SnapiEnv,
    wrapper_id: u32,
    url_id: u32,
    context_id: u32,
    export_names_id: u32,
    synthetic_eval_steps_id: u32,
    handle_out: *mut u32,
    requests_out: *mut u32,
    has_top_level_await_out: *mut u8,
) -> i32 {
    let _ = (url_id, context_id);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(wrapper) = state.get(wrapper_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let Some(export_names_value) = state
        .get(export_names_id)
        .filter(|value| Array::is_array(value))
        .cloned()
    else {
        return NAPI_INVALID_ARG;
    };
    let Some(evaluate) = state
        .get(synthetic_eval_steps_id)
        .and_then(|value| value.dyn_ref::<Function>())
        .cloned()
    else {
        return NAPI_FUNCTION_EXPECTED;
    };

    let export_names_array = Array::from(&export_names_value);
    let mut export_names = Vec::with_capacity(export_names_array.length() as usize);
    let namespace = Object::new();
    for value in export_names_array.iter() {
        let Some(name) = value.as_string() else {
            return NAPI_STRING_EXPECTED;
        };
        if Reflect::set(&namespace, &JsValue::from_str(&name), &JsValue::UNDEFINED).is_err() {
            return NAPI_GENERIC_FAILURE;
        }
        export_names.push(name);
    }

    let handle = state.next_module;
    state.next_module = state.next_module.wrapping_add(1).max(1);
    state.synthetic_modules.insert(
        handle,
        SyntheticModule {
            wrapper,
            export_names,
            evaluate,
            namespace,
            status: 0,
            error: None,
            evaluation: None,
        },
    );
    let requests_id = state.insert(Array::new().into());
    for result in [
        unsafe { write(handle_out, handle) },
        unsafe { write(requests_out, requests_id) },
        unsafe { write(has_top_level_await_out, 0) },
    ] {
        if let Err(error) = result {
            return error;
        }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_create(
    env: SnapiEnv,
    kind: i32,
    wrapper_id: u32,
    url_id: u32,
    context_id: u32,
    source_text_id: u32,
    source_bytecode_id: u32,
    line_offset: i32,
    column_offset: i32,
    host_defined_option_id: u32,
    export_names_id: u32,
    synthetic_eval_steps_id: u32,
    handle_out: *mut u32,
    requests_out: *mut u32,
    has_top_level_await_out: *mut u8,
) -> i32 {
    match kind {
        1 => unsafe {
            host_js_create_source_text_module(
                env,
                wrapper_id,
                url_id,
                context_id,
                source_text_id,
                source_bytecode_id,
                line_offset,
                column_offset,
                host_defined_option_id,
                handle_out,
                requests_out,
                has_top_level_await_out,
            )
        },
        2 => unsafe {
            host_js_create_synthetic_module(
                env,
                wrapper_id,
                url_id,
                context_id,
                export_names_id,
                synthetic_eval_steps_id,
                handle_out,
                requests_out,
                has_top_level_await_out,
            )
        },
        _ => NAPI_INVALID_ARG,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_destroy(
    env: SnapiEnv,
    handle_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    state.synthetic_modules.remove(&handle_id);
    state.source_text_modules.remove(&handle_id);
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_link(
    env: SnapiEnv,
    handle_id: u32,
    count: u32,
    linked_handle_ids: *const u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.synthetic_modules.contains_key(&handle_id) {
        return if count == 0 {
            NAPI_OK
        } else {
            NAPI_INVALID_ARG
        };
    }
    let Some(module) = state.source_text_modules.get(&handle_id) else {
        return NAPI_INVALID_ARG;
    };
    if count != module.requests.length() || (count != 0 && linked_handle_ids.is_null()) {
        return NAPI_INVALID_ARG;
    }
    let linked = if count == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(linked_handle_ids, count as usize) }.to_vec()
    };
    if linked.iter().any(|linked_handle| {
        !state.synthetic_modules.contains_key(linked_handle)
            && !state.source_text_modules.contains_key(linked_handle)
    }) {
        return NAPI_INVALID_ARG;
    }
    state
        .source_text_modules
        .get_mut(&handle_id)
        .expect("source module disappeared")
        .linked_handles = linked;
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_instantiate(
    env: SnapiEnv,
    handle_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if let Some(module) = state.synthetic_modules.get_mut(&handle_id) {
        if module.status < 2 {
            module.status = 2;
        }
        return NAPI_OK;
    }
    let Some(module) = state.source_text_modules.get_mut(&handle_id) else {
        return NAPI_INVALID_ARG;
    };
    if module.linked_handles.len() != module.requests.length() as usize {
        return NAPI_INVALID_ARG;
    }
    if module.status < 2 {
        module.status = 2;
    }
    NAPI_OK
}

fn module_namespace(state: &HostJsEnv, handle_id: u32) -> Option<Object> {
    state
        .synthetic_modules
        .get(&handle_id)
        .map(|module| module.namespace.clone())
        .or_else(|| {
            state
                .source_text_modules
                .get(&handle_id)
                .map(|module| module.namespace.clone())
        })
}

fn module_evaluation(state: &HostJsEnv, handle_id: u32) -> Option<JsValue> {
    state
        .synthetic_modules
        .get(&handle_id)
        .and_then(|module| module.evaluation.clone())
        .or_else(|| {
            state
                .source_text_modules
                .get(&handle_id)
                .and_then(|module| module.evaluation.clone())
        })
}

fn start_module_evaluation(state: &mut HostJsEnv, handle_id: u32) -> Result<JsValue, JsValue> {
    if let Some(evaluation) = module_evaluation(state, handle_id) {
        return Ok(evaluation);
    }

    if let Some(module) = state.synthetic_modules.get_mut(&handle_id) {
        module.status = 3;
        let evaluate = module.evaluate.clone();
        let wrapper = module.wrapper.clone();
        match evaluate.apply(&wrapper, &Array::new()) {
            Ok(_) => {
                let promise: JsValue = Promise::resolve(&JsValue::UNDEFINED).into();
                let module = state
                    .synthetic_modules
                    .get_mut(&handle_id)
                    .expect("synthetic module disappeared during evaluation");
                module.status = 4;
                module.evaluation = Some(promise.clone());
                return Ok(promise);
            }
            Err(error) => {
                let module = state
                    .synthetic_modules
                    .get_mut(&handle_id)
                    .expect("synthetic module disappeared during evaluation");
                module.status = 5;
                module.error = Some(error.clone());
                return Err(error);
            }
        }
    }

    let evaluation = wasmer_napi_create_module_evaluation();
    let promise = Reflect::get(&evaluation, &JsValue::from_str("promise"))?;

    let (linked_handles, execute, namespace, url) = {
        let Some(module) = state.source_text_modules.get_mut(&handle_id) else {
            return Err(TypeError::new("Unknown module handle").into());
        };
        if module.linked_handles.len() != module.requests.length() as usize {
            return Err(TypeError::new("Module must be linked before evaluation").into());
        }
        module.status = 3;
        module.evaluation = Some(promise.clone());
        (
            module.linked_handles.clone(),
            module.execute.clone(),
            module.namespace.clone(),
            module.url.clone(),
        )
    };

    let dependencies = Array::new();
    let imports = Array::new();
    for (index, linked_handle) in linked_handles.into_iter().enumerate() {
        let dependency = match start_module_evaluation(state, linked_handle) {
            Ok(value) => value,
            Err(error) => {
                wasmer_napi_reject_module_evaluation(&evaluation, &error);
                return Ok(promise);
            }
        };
        dependencies.set(index as u32, dependency);
        let Some(namespace) = module_namespace(state, linked_handle) else {
            let error: JsValue = TypeError::new("Linked module disappeared").into();
            wasmer_napi_reject_module_evaluation(&evaluation, &error);
            return Ok(promise);
        };
        imports.set(index as u32, namespace.into());
    }
    let import_meta = Object::new();
    Reflect::set(
        &import_meta,
        &JsValue::from_str("url"),
        &JsValue::from_str(&url),
    )?;
    wasmer_napi_finish_module_evaluation(
        &evaluation,
        &dependencies,
        &execute,
        &imports,
        &namespace,
        &import_meta,
    );
    Ok(promise)
}

fn refresh_module_status(state: &mut HostJsEnv, handle_id: u32) -> Result<i32, i32> {
    let Some(evaluation) = module_evaluation(state, handle_id) else {
        return state
            .synthetic_modules
            .get(&handle_id)
            .map(|module| module.status)
            .or_else(|| {
                state
                    .source_text_modules
                    .get(&handle_id)
                    .map(|module| module.status)
            })
            .ok_or(NAPI_INVALID_ARG);
    };
    let details = wasmer_napi_get_promise_details(&evaluation);
    let promise_state = details.get(0).as_f64().unwrap_or(0.0) as i32;
    let result = details.get(1);
    let (status, error) = match promise_state {
        1 => (4, None),
        2 => (5, Some(result)),
        _ => (3, None),
    };
    if let Some(module) = state.synthetic_modules.get_mut(&handle_id) {
        module.status = status;
        if error.is_some() {
            module.error = error;
        }
    } else if let Some(module) = state.source_text_modules.get_mut(&handle_id) {
        module.status = status;
        if error.is_some() {
            module.error = error;
        }
    } else {
        return Err(NAPI_INVALID_ARG);
    }
    Ok(status)
}

fn evaluate_module_sync(
    state: &mut HostJsEnv,
    handle_id: u32,
    visiting: &mut Vec<u32>,
) -> Result<Object, JsValue> {
    if visiting.contains(&handle_id) {
        return module_namespace(state, handle_id)
            .ok_or_else(|| TypeError::new("Unknown module handle").into());
    }
    if let Some(module) = state.synthetic_modules.get(&handle_id) {
        if module.status == 4 {
            return Ok(module.namespace.clone());
        }
        let evaluate = module.evaluate.clone();
        let wrapper = module.wrapper.clone();
        let namespace = module.namespace.clone();
        state.synthetic_modules.get_mut(&handle_id).unwrap().status = 3;
        evaluate.apply(&wrapper, &Array::new())?;
        state.synthetic_modules.get_mut(&handle_id).unwrap().status = 4;
        return Ok(namespace);
    }

    let (linked_handles, execute, namespace, url, has_top_level_await) = {
        let Some(module) = state.source_text_modules.get(&handle_id) else {
            return Err(TypeError::new("Unknown module handle").into());
        };
        (
            module.linked_handles.clone(),
            module.execute.clone(),
            module.namespace.clone(),
            module.url.clone(),
            module.has_top_level_await,
        )
    };
    if has_top_level_await {
        return Err(TypeError::new(
            "Cannot synchronously evaluate a module graph with top-level await",
        )
        .into());
    }
    state
        .source_text_modules
        .get_mut(&handle_id)
        .unwrap()
        .status = 3;
    visiting.push(handle_id);
    let imports = Array::new();
    for (index, linked_handle) in linked_handles.into_iter().enumerate() {
        let dependency_namespace = evaluate_module_sync(state, linked_handle, visiting)?;
        imports.set(index as u32, dependency_namespace.into());
    }
    visiting.pop();
    let import_meta = Object::new();
    Reflect::set(
        &import_meta,
        &JsValue::from_str("url"),
        &JsValue::from_str(&url),
    )?;
    let args = Array::new();
    args.push(&imports);
    args.push(&namespace);
    args.push(&import_meta);
    execute.apply(&JsValue::UNDEFINED, &args)?;
    state
        .source_text_modules
        .get_mut(&handle_id)
        .unwrap()
        .status = 4;
    Ok(namespace)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_evaluate(
    env: SnapiEnv,
    handle_id: u32,
    timeout: i64,
    break_on_sigint: i32,
    result_out: *mut u32,
) -> i32 {
    let _ = (timeout, break_on_sigint);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    match start_module_evaluation(state, handle_id) {
        Ok(promise) => {
            let id = state.insert(promise);
            unsafe { write(result_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_evaluate_sync(
    env: SnapiEnv,
    handle_id: u32,
    filename_id: u32,
    parent_filename_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (filename_id, parent_filename_id);
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    match evaluate_module_sync(state, handle_id, &mut Vec::new()) {
        Ok(namespace) => {
            let id = state.insert(namespace.into());
            unsafe { write(result_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
        }
        Err(error) => {
            if let Some(module) = state.synthetic_modules.get_mut(&handle_id) {
                module.status = 5;
                module.error = Some(error.clone());
            } else if let Some(module) = state.source_text_modules.get_mut(&handle_id) {
                module.status = 5;
                module.error = Some(error.clone());
            }
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_get_namespace(
    env: SnapiEnv,
    handle_id: u32,
    result_out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(namespace) = module_namespace(state, handle_id) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(namespace.into());
    unsafe { write(result_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
}

fn module_graph_has_top_level_await(
    state: &HostJsEnv,
    handle_id: u32,
    visited: &mut Vec<u32>,
) -> Option<bool> {
    if visited.contains(&handle_id) || state.synthetic_modules.contains_key(&handle_id) {
        return Some(false);
    }
    let module = state.source_text_modules.get(&handle_id)?;
    if module.has_top_level_await {
        return Some(true);
    }
    visited.push(handle_id);
    for linked_handle in &module.linked_handles {
        if module_graph_has_top_level_await(state, *linked_handle, visited)? {
            return Some(true);
        }
    }
    Some(false)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_get_state(
    env: SnapiEnv,
    handle_id: u32,
    status_out: *mut i32,
    error_out: *mut u32,
    has_async_graph_out: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if status_out.is_null() && error_out.is_null() && has_async_graph_out.is_null() {
        return NAPI_INVALID_ARG;
    }
    let status = match refresh_module_status(state, handle_id) {
        Ok(status) => status,
        Err(error) => return error,
    };
    let has_async_graph = if has_async_graph_out.is_null() {
        None
    } else {
        let Some(has_async_graph) =
            module_graph_has_top_level_await(state, handle_id, &mut Vec::new())
        else {
            return NAPI_INVALID_ARG;
        };
        Some(status >= 2 && has_async_graph)
    };
    if !status_out.is_null() {
        if let Err(error) = unsafe { write(status_out, status) } {
            return error;
        }
    }
    if !error_out.is_null() {
        let error = state
            .synthetic_modules
            .get(&handle_id)
            .and_then(|module| module.error.clone())
            .or_else(|| {
                state
                    .source_text_modules
                    .get(&handle_id)
                    .and_then(|module| module.error.clone())
            })
            .unwrap_or(JsValue::UNDEFINED);
        let error_id = state.insert(error);
        if let Err(error) = unsafe { write(error_out, error_id) } {
            return error;
        }
    }
    if let Some(has_async_graph) = has_async_graph {
        if let Err(error) = unsafe { write(has_async_graph_out, i32::from(has_async_graph)) } {
            return error;
        }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_check_unsettled_top_level_await(
    env: SnapiEnv,
    handle_id: u32,
    warnings: i32,
    settled_out: *mut i32,
) -> i32 {
    let _ = warnings;
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let settled = if state.source_text_modules.contains_key(&handle_id) {
        let is_async =
            module_graph_has_top_level_await(state, handle_id, &mut Vec::new()).unwrap_or(false);
        !is_async || refresh_module_status(state, handle_id).unwrap_or(4) != 3
    } else if state.synthetic_modules.contains_key(&handle_id) {
        true
    } else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(settled_out, i32::from(settled)) }.map_or_else(|error| error, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_set_export(
    env: SnapiEnv,
    handle_id: u32,
    export_name_id: u32,
    export_value_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(name) = state.get(export_name_id).and_then(JsValue::as_string) else {
        return NAPI_STRING_EXPECTED;
    };
    let Some(value) = state.get(export_value_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let Some(module) = state.synthetic_modules.get_mut(&handle_id) else {
        return NAPI_INVALID_ARG;
    };
    if !module
        .export_names
        .iter()
        .any(|candidate| candidate == &name)
    {
        state.last_exception =
            Some(TypeError::new("Synthetic module export is not defined").into());
        return NAPI_PENDING_EXCEPTION;
    }
    match Reflect::set(&module.namespace, &JsValue::from_str(&name), &value) {
        Ok(true) => NAPI_OK,
        Ok(false) => NAPI_GENERIC_FAILURE,
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_set_module_source_object(
    env: SnapiEnv,
    handle_id: u32,
    source_object_id: u32,
) -> i32 {
    let _ = (env, handle_id, source_object_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_get_module_source_object(
    env: SnapiEnv,
    handle_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (env, handle_id, result_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_create_cached_data(
    env: SnapiEnv,
    handle_id: u32,
    result_out: *mut u32,
) -> i32 {
    let _ = (env, handle_id, result_out);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_set_hooks(
    env: SnapiEnv,
    import_callback_id: u32,
    import_meta_callback_id: u32,
) -> i32 {
    let _ = (env, import_callback_id, import_meta_callback_id);
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_unofficial_module_wrap_create_required_module_facade(
    env: SnapiEnv,
    handle_id: u32,
    result_out: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(namespace) = module_namespace(state, handle_id) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(namespace.into());
    unsafe { write(result_out, id) }.map_or_else(|error| error, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_instanceof(
    env: SnapiEnv,
    obj_id: u32,
    ctor_id: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(object), Some(ctor)) = (state.get(obj_id), state.get(ctor_id)) else {
        return NAPI_INVALID_ARG;
    };
    if !ctor.is_function() {
        return NAPI_FUNCTION_EXPECTED;
    }
    unsafe { write(result, i32::from(wasmer_napi_instanceof(object, ctor))) }
        .map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_coerce_to_bool(
    env: SnapiEnv,
    id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    let coerced = JsValue::from_bool(value.is_truthy());
    let id = state.insert(coerced);
    unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_coerce_to_number(
    env: SnapiEnv,
    id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_number(&value) {
        Ok(number) => {
            let id = state.insert(number);
            unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_coerce_to_string(
    env: SnapiEnv,
    id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    match js_string(&value) {
        Ok(text) => {
            let id = state.insert(JsValue::from_str(&text));
            unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_coerce_to_object(
    env: SnapiEnv,
    id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    if value.is_null() || value.is_undefined() {
        return NAPI_OBJECT_EXPECTED;
    }
    let id = state.insert(Object::from(value).into());
    unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_has_property(
    env: SnapiEnv,
    obj_id: u32,
    key_id: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(object), Some(key)) = (state.get(obj_id), state.get(key_id)) else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::has(object, key) {
        Ok(value) => {
            unsafe { write(result, i32::from(value)) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_has_own_property(
    env: SnapiEnv,
    obj_id: u32,
    key_id: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(object), Some(key)) = (state.get(obj_id), state.get(key_id)) else {
        return NAPI_INVALID_ARG;
    };
    let object = Object::from(object.clone());
    match Reflect::get_own_property_descriptor(&object, key) {
        Ok(descriptor) => unsafe { write(result, i32::from(!descriptor.is_undefined())) }
            .map_or_else(|err| err, |()| NAPI_OK),
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_delete_property(
    env: SnapiEnv,
    obj_id: u32,
    key_id: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(object), Some(key)) = (state.get(obj_id), state.get(key_id)) else {
        return NAPI_INVALID_ARG;
    };
    let object = Object::from(object.clone());
    match Reflect::delete_property(&object, key) {
        Ok(value) => {
            unsafe { write(result, i32::from(value)) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_has_named_property(
    env: SnapiEnv,
    obj_id: u32,
    name: *const i8,
    result: *mut i32,
) -> i32 {
    let Ok(name) = (unsafe { cstr(name) }) else {
        return NAPI_INVALID_ARG;
    };
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::has(object, &JsValue::from_str(&name)) {
        Ok(value) => {
            unsafe { write(result, i32::from(value)) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_has_element(
    env: SnapiEnv,
    obj_id: u32,
    index: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    match Reflect::has(object, &JsValue::from_f64(index as f64)) {
        Ok(value) => {
            unsafe { write(result, i32::from(value)) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_delete_element(
    env: SnapiEnv,
    obj_id: u32,
    index: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    let object = Object::from(object.clone());
    match Reflect::delete_property(&object, &JsValue::from_f64(index as f64)) {
        Ok(value) => {
            unsafe { write(result, i32::from(value)) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_all_property_names(
    env: SnapiEnv,
    obj_id: u32,
    mode: i32,
    filter: i32,
    conversion: i32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_get_all_property_names(object, mode, filter, conversion) {
        Ok(keys) => {
            let id = state.insert(keys.into());
            unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_prototype(
    env: SnapiEnv,
    obj_id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    let proto = Object::get_prototype_of(&Object::from(object.clone()));
    let id = state.insert(proto.into());
    unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_object_freeze(env: SnapiEnv, obj_id: u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    Object::freeze(&Object::from(object.clone()));
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_object_seal(env: SnapiEnv, obj_id: u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(object) = state.get(obj_id) else {
        return NAPI_INVALID_ARG;
    };
    Object::seal(&Object::from(object.clone()));
    NAPI_OK
}

unsafe fn throw_c_error(env: SnapiEnv, code: *const i8, message: *const i8, kind: u8) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let message = unsafe { cstr(message) }.unwrap_or_default();
    let error: JsValue = match kind {
        1 => TypeError::new(&message).into(),
        2 => js_sys::RangeError::new(&message).into(),
        _ => Error::new(&message).into(),
    };
    if !code.is_null() {
        let code = unsafe { cstr(code) }.unwrap_or_default();
        let _ = Reflect::set(
            &error,
            &JsValue::from_str("code"),
            &JsValue::from_str(&code),
        );
    }
    state.last_exception = Some(error);
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_throw_error(
    env: SnapiEnv,
    code: *const i8,
    msg: *const i8,
) -> i32 {
    unsafe { throw_c_error(env, code, msg, 0) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_throw_type_error(
    env: SnapiEnv,
    code: *const i8,
    msg: *const i8,
) -> i32 {
    unsafe { throw_c_error(env, code, msg, 1) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_throw_range_error(
    env: SnapiEnv,
    code: *const i8,
    msg: *const i8,
) -> i32 {
    unsafe { throw_c_error(env, code, msg, 2) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_symbol(
    env: SnapiEnv,
    description_id: u32,
    out_id: *mut u32,
) -> i32 {
    let description = {
        let Ok(state) = (unsafe { env_mut(env) }) else {
            return NAPI_INVALID_ARG;
        };
        if description_id == 0 {
            JsValue::UNDEFINED
        } else {
            let Some(value) = state.get(description_id).cloned() else {
                return NAPI_INVALID_ARG;
            };
            if !value.is_string() {
                return NAPI_STRING_EXPECTED;
            }
            value
        }
    };
    unsafe { put_value(env, out_id, wasmer_napi_symbol(&description)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_bigint_int64(
    env: SnapiEnv,
    value: i64,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, value, out_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_bigint_uint64(
    env: SnapiEnv,
    value: u64,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, value, out_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_bigint_int64(
    env: SnapiEnv,
    id: u32,
    value: *mut i64,
    lossless: *mut i32,
) -> i32 {
    let _ = (env, id, value, lossless);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_bigint_uint64(
    env: SnapiEnv,
    id: u32,
    value: *mut u64,
    lossless: *mut i32,
) -> i32 {
    let _ = (env, id, value, lossless);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_date(
    env: SnapiEnv,
    time: f64,
    out_id: *mut u32,
) -> i32 {
    unsafe { put_value(env, out_id, Date::new(&JsValue::from_f64(time)).into()) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_date_value(
    env: SnapiEnv,
    id: u32,
    result: *mut f64,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(date) = state.get(id).and_then(|value| value.dyn_ref::<Date>()) else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(result, date.get_time()) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_external_arraybuffer(
    env: SnapiEnv,
    data_addr: u64,
    byte_length: u32,
    backing_store_token_out: *mut u64,
    out_id: *mut u32,
) -> i32 {
    let source = if data_addr == 0 && byte_length != 0 {
        return NAPI_INVALID_ARG;
    } else if byte_length == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(data_addr as *const u8, byte_length as usize) }
    };
    let view = Uint8Array::from(source);
    let buffer = view.buffer();
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(buffer.into());
    state.backing_tokens.insert(id, data_addr);
    if unsafe { write(out_id, id) }.is_err() {
        return NAPI_INVALID_ARG;
    }
    if !backing_store_token_out.is_null() {
        unsafe { backing_store_token_out.write(data_addr) }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_external_buffer(
    env: SnapiEnv,
    data_addr: u64,
    byte_length: u32,
    backing_store_token_out: *mut u64,
    out_id: *mut u32,
) -> i32 {
    let source = if data_addr == 0 && byte_length != 0 {
        return NAPI_INVALID_ARG;
    } else if byte_length == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(data_addr as *const u8, byte_length as usize) }
    };
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let array = Uint8Array::from(source);
    let value = wasmer_napi_buffer_view(&array.buffer(), 0, array.length());
    let id = state.insert(value);
    state.backing_tokens.insert(id, data_addr);
    if unsafe { write(out_id, id) }.is_err() {
        return NAPI_INVALID_ARG;
    }
    if !backing_store_token_out.is_null() {
        unsafe { backing_store_token_out.write(data_addr) }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_detach_arraybuffer(env: SnapiEnv, id: u32) -> i32 {
    let _ = (env, id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_is_detached_arraybuffer(
    env: SnapiEnv,
    id: u32,
    result: *mut i32,
) -> i32 {
    let _ = (env, id, result);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_is_sharedarraybuffer(
    env: SnapiEnv,
    id: u32,
    result: *mut i32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id) else {
        return NAPI_INVALID_ARG;
    };
    unsafe {
        write(
            result,
            i32::from(value.is_instance_of::<SharedArrayBuffer>()),
        )
    }
    .map_or_else(|error| error, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_sharedarraybuffer(
    env: SnapiEnv,
    byte_length: u32,
    data_out: *mut u64,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(SharedArrayBuffer::new(byte_length).into());
    if unsafe { write(data_out, 0) }.is_err() || unsafe { write(out_id, id) }.is_err() {
        NAPI_INVALID_ARG
    } else {
        NAPI_OK
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_node_api_set_prototype(
    env: SnapiEnv,
    object_id: u32,
    prototype_id: u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let (Some(object), Some(prototype)) = (state.get(object_id), state.get(prototype_id)) else {
        return NAPI_INVALID_ARG;
    };
    let prototype = Object::from(prototype.clone());
    Object::set_prototype_of(&Object::from(object.clone()), &prototype);
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_typedarray(
    env: SnapiEnv,
    typ: i32,
    length: u32,
    arraybuffer_id: u32,
    byte_offset: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(buffer) = state.get(arraybuffer_id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    match wasmer_napi_typed_array(typ, &buffer, byte_offset, length) {
        Ok(value) => {
            let id = state.insert(value);
            unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
        }
        Err(error) => {
            state.last_exception = Some(error);
            NAPI_PENDING_EXCEPTION
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_typedarray_info(
    env: SnapiEnv,
    id: u32,
    type_out: *mut i32,
    length_out: *mut u32,
    data_out: *mut u64,
    arraybuffer_out: *mut u32,
    byte_offset_out: *mut u32,
    backing_store_token_out: *mut u64,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.get(id).cloned() else {
        return NAPI_INVALID_ARG;
    };
    let kind = wasmer_napi_typed_array_kind(&value);
    if kind < 0 {
        return NAPI_INVALID_ARG;
    }
    let Ok(buffer) = Reflect::get(&value, &JsValue::from_str("buffer")) else {
        return NAPI_INVALID_ARG;
    };
    let length = Reflect::get(&value, &JsValue::from_str("length"))
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as u32;
    let byte_offset = Reflect::get(&value, &JsValue::from_str("byteOffset"))
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as u32;
    if (!type_out.is_null() && unsafe { write(type_out, kind) }.is_err())
        || (!length_out.is_null() && unsafe { write(length_out, length) }.is_err())
        || (!byte_offset_out.is_null() && unsafe { write(byte_offset_out, byte_offset) }.is_err())
    {
        return NAPI_INVALID_ARG;
    }
    if !data_out.is_null() {
        let byte_length = Reflect::get(&value, &JsValue::from_str("byteLength"))
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as u32;
        let raw =
            Uint8Array::new_with_byte_offset_and_length(&buffer, byte_offset, byte_length).to_vec();
        let data = store_bytes(raw);
        if unsafe { write(data_out, data) }.is_err() {
            return NAPI_INVALID_ARG;
        }
        if !backing_store_token_out.is_null() {
            let backing_store_token = state.backing_store_token(id).unwrap_or(id as u64);
            if unsafe { write(backing_store_token_out, backing_store_token) }.is_err() {
                return NAPI_INVALID_ARG;
            }
        }
    }
    if !arraybuffer_out.is_null() {
        let buffer_id = state.insert(buffer);
        if unsafe { write(arraybuffer_out, buffer_id) }.is_err() {
            return NAPI_INVALID_ARG;
        }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_dataview(
    env: SnapiEnv,
    byte_length: u32,
    arraybuffer_id: u32,
    byte_offset: u32,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, byte_length, arraybuffer_id, byte_offset, out_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_dataview_info(
    env: SnapiEnv,
    id: u32,
    byte_length_out: *mut u32,
    data_out: *mut u64,
    arraybuffer_out: *mut u32,
    byte_offset_out: *mut u32,
    backing_store_token_out: *mut u64,
) -> i32 {
    let _ = (
        env,
        id,
        byte_length_out,
        data_out,
        arraybuffer_out,
        byte_offset_out,
        backing_store_token_out,
    );
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_external(
    env: SnapiEnv,
    data_val: u64,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.insert(Object::new().into());
    state.externals.insert(id, data_val);
    unsafe { write(out_id, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_open_handle_scope(env: SnapiEnv, scope_out: *mut u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let id = state.open_value_frame();
    unsafe { write(scope_out, id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_close_handle_scope(env: SnapiEnv, scope_id: u32) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.close_value_frame(scope_id) {
        NAPI_OK
    } else {
        NAPI_INVALID_ARG
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_external(
    env: SnapiEnv,
    id: u32,
    data_out: *mut u64,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = state.externals.get(&id).copied() else {
        return NAPI_INVALID_ARG;
    };
    unsafe { write(data_out, value) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_open_escapable_handle_scope(
    env: SnapiEnv,
    scope_out: *mut u32,
) -> i32 {
    unsafe { snapi_bridge_open_handle_scope(env, scope_out) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_close_escapable_handle_scope(
    env: SnapiEnv,
    scope_id: u32,
) -> i32 {
    unsafe { snapi_bridge_close_handle_scope(env, scope_id) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_escape_handle(
    env: SnapiEnv,
    scope_id: u32,
    escapee_id: u32,
    out_id: *mut u32,
) -> i32 {
    let Ok(state) = (unsafe { env_mut(env) }) else {
        return NAPI_INVALID_ARG;
    };
    if state.get(escapee_id).is_none() || !state.escape_value(scope_id, escapee_id) {
        return NAPI_INVALID_ARG;
    }
    unsafe { write(out_id, escapee_id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_create_bigint_words(
    env: SnapiEnv,
    sign_bit: i32,
    word_count: u32,
    words: *const u64,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, sign_bit, word_count, words, out_id);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_value_bigint_words(
    env: SnapiEnv,
    id: u32,
    sign_bit: *mut i32,
    word_count: *mut usize,
    words: *mut u64,
) -> i32 {
    let _ = (env, id, sign_bit, word_count, words);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_adjust_external_memory(
    env: SnapiEnv,
    change: i64,
    adjusted: *mut i64,
) -> i32 {
    let _ = (env, change, adjusted);
    NAPI_GENERIC_FAILURE
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_node_version(
    env: SnapiEnv,
    major: *mut u32,
    minor: *mut u32,
    patch: *mut u32,
) -> i32 {
    let _ = env;
    if unsafe { write(major, 22) }.is_err()
        || unsafe { write(minor, 0) }.is_err()
        || unsafe { write(patch, 0) }.is_err()
    {
        NAPI_INVALID_ARG
    } else {
        NAPI_OK
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_add_finalizer(
    env: SnapiEnv,
    obj_id: u32,
    data_val: u64,
    ref_out: *mut u32,
) -> i32 {
    let _ = (env, obj_id, data_val, ref_out);
    NAPI_GENERIC_FAILURE
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_wrap_finalized(
    env: SnapiEnv,
    obj_id: u32,
    native_data: u64,
    guest_env: u32,
    wasm_fn_ptr: u32,
    finalize_data: u32,
    finalize_hint: u32,
    ref_out: *mut u32,
) -> i32 {
    let mut reference_id = 0u32;
    if !ref_out.is_null() {
        let status = unsafe { snapi_bridge_create_reference(env, obj_id, 0, &mut reference_id) };
        if status != NAPI_OK {
            return status;
        }
    }

    let registered = {
        let Ok(state) = (unsafe { env_mut(env) }) else {
            if reference_id != 0 {
                let _ = unsafe { snapi_bridge_delete_reference(env, reference_id) };
            }
            return NAPI_INVALID_ARG;
        };
        let Some(wrap_id) = state.wrap_id(obj_id, true) else {
            if reference_id != 0 {
                let _ = unsafe { snapi_bridge_delete_reference(env, reference_id) };
            }
            return NAPI_INVALID_ARG;
        };
        if state.wraps.contains_key(&wrap_id)
            || !state.register_guest_finalizer(
                obj_id,
                guest_env,
                wasm_fn_ptr,
                finalize_data,
                finalize_hint,
                Some(wrap_id),
            )
        {
            false
        } else {
            state.wraps.insert(wrap_id, native_data);
            true
        }
    };
    if !registered {
        if reference_id != 0 {
            let _ = unsafe { snapi_bridge_delete_reference(env, reference_id) };
        }
        return NAPI_INVALID_ARG;
    }
    if !ref_out.is_null() {
        if unsafe { write(ref_out, reference_id) }.is_err() {
            return NAPI_INVALID_ARG;
        }
    }
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_add_finalizer_cb(
    env: SnapiEnv,
    obj_id: u32,
    _data_val: u64,
    guest_env: u32,
    wasm_fn_ptr: u32,
    finalize_data: u32,
    finalize_hint: u32,
    ref_out: *mut u32,
) -> i32 {
    let mut reference_id = 0u32;
    if !ref_out.is_null() {
        let status = unsafe { snapi_bridge_create_reference(env, obj_id, 0, &mut reference_id) };
        if status != NAPI_OK {
            return status;
        }
    }
    let registered = unsafe { env_mut(env) }.is_ok_and(|state| {
        state.register_guest_finalizer(
            obj_id,
            guest_env,
            wasm_fn_ptr,
            finalize_data,
            finalize_hint,
            None,
        )
    });
    if !registered {
        if reference_id != 0 {
            let _ = unsafe { snapi_bridge_delete_reference(env, reference_id) };
        }
        return NAPI_INVALID_ARG;
    }
    if !ref_out.is_null() {
        if unsafe { write(ref_out, reference_id) }.is_err() {
            return NAPI_INVALID_ARG;
        }
    }
    NAPI_OK
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_register_callback_pair(
    env: SnapiEnv,
    reg_id: u32,
    guest_env: u32,
    wasm_getter_fn_ptr: u32,
    wasm_setter_fn_ptr: u32,
    data_val: u64,
) {
    if let Ok(state) = unsafe { env_mut(env) } {
        state.callback_regs.insert(
            reg_id,
            CallbackReg {
                guest_env,
                wasm_fn_ptr: wasm_getter_fn_ptr,
                data: data_val,
            },
        );
        state.callback_regs.insert(
            reg_id | 0x8000_0000,
            CallbackReg {
                guest_env,
                wasm_fn_ptr: wasm_setter_fn_ptr,
                data: data_val,
            },
        );
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_get_new_target(
    env: SnapiEnv,
    cbinfo_id: u32,
    out_id: *mut u32,
) -> i32 {
    let _ = (env, cbinfo_id, out_id);
    NAPI_GENERIC_FAILURE
}

#[allow(clippy::too_many_arguments)]
unsafe fn define_properties_impl(
    env: SnapiEnv,
    object: &JsValue,
    count: u32,
    names: *const *const i8,
    name_ids: *const u32,
    types: *const u32,
    value_ids: *const u32,
    method_regs: *const u32,
    getter_regs: *const u32,
    setter_regs: *const u32,
    attributes: *const i32,
) -> i32 {
    let object = Object::from(object.clone());
    for index in 0..count as usize {
        let property_type = if types.is_null() {
            0
        } else {
            unsafe { *types.add(index) }
        };
        let key = {
            let Ok(state) = (unsafe { env_mut(env) }) else {
                return NAPI_INVALID_ARG;
            };
            let name_id = if name_ids.is_null() {
                0
            } else {
                unsafe { *name_ids.add(index) }
            };
            if name_id != 0 {
                state.get(name_id).cloned().unwrap_or(JsValue::UNDEFINED)
            } else {
                if names.is_null() {
                    return NAPI_INVALID_ARG;
                }
                let name = unsafe { cstr(*names.add(index)) }.unwrap_or_default();
                JsValue::from_str(&name)
            }
        };
        let attrs = if attributes.is_null() {
            0
        } else {
            unsafe { *attributes.add(index) }
        };
        let descriptor = Object::new();
        let _ = Reflect::set(
            &descriptor,
            &JsValue::from_str("enumerable"),
            &JsValue::from_bool(attrs & 2 != 0),
        );
        let _ = Reflect::set(
            &descriptor,
            &JsValue::from_str("configurable"),
            &JsValue::from_bool(attrs & 4 != 0),
        );

        let callback_name = key.as_string().unwrap_or_default();
        let callback = |reg: u32| -> Result<JsValue, i32> {
            if reg == 0 {
                return Err(NAPI_INVALID_ARG);
            }
            let callback_name = CString::new(callback_name.as_bytes()).unwrap_or_default();
            let mut id = 0;
            let status = unsafe {
                snapi_bridge_create_function(
                    env,
                    callback_name.as_ptr(),
                    callback_name.as_bytes().len() as u32,
                    reg,
                    &mut id,
                )
            };
            if status != NAPI_OK {
                return Err(status);
            }
            let state = unsafe { env_mut(env) }?;
            state.get(id).cloned().ok_or(NAPI_INVALID_ARG)
        };

        match property_type {
            0 => {
                let value_id = if value_ids.is_null() {
                    0
                } else {
                    unsafe { *value_ids.add(index) }
                };
                let value = unsafe { env_mut(env) }
                    .ok()
                    .and_then(|state| state.get(value_id).cloned())
                    .unwrap_or(JsValue::UNDEFINED);
                let _ = Reflect::set(&descriptor, &JsValue::from_str("value"), &value);
                let _ = Reflect::set(
                    &descriptor,
                    &JsValue::from_str("writable"),
                    &JsValue::from_bool(attrs & 1 != 0),
                );
            }
            1 => {
                let reg = if method_regs.is_null() {
                    0
                } else {
                    unsafe { *method_regs.add(index) }
                };
                let Ok(value) = callback(reg) else {
                    return NAPI_INVALID_ARG;
                };
                let _ = Reflect::set(&descriptor, &JsValue::from_str("value"), &value);
                let _ = Reflect::set(
                    &descriptor,
                    &JsValue::from_str("writable"),
                    &JsValue::from_bool(attrs & 1 != 0),
                );
            }
            2 => {
                let reg = if getter_regs.is_null() {
                    0
                } else {
                    unsafe { *getter_regs.add(index) }
                };
                let Ok(getter) = callback(reg) else {
                    return NAPI_INVALID_ARG;
                };
                let _ = Reflect::set(&descriptor, &JsValue::from_str("get"), &getter);
            }
            3 => {
                let reg = if setter_regs.is_null() {
                    0
                } else {
                    unsafe { *setter_regs.add(index) }
                };
                let Ok(setter) = callback(reg) else {
                    return NAPI_INVALID_ARG;
                };
                let _ = Reflect::set(&descriptor, &JsValue::from_str("set"), &setter);
            }
            4 => {
                let reg = if getter_regs.is_null() {
                    0
                } else {
                    unsafe { *getter_regs.add(index) }
                };
                let Ok(getter) = callback(reg) else {
                    return NAPI_INVALID_ARG;
                };
                let Ok(setter) = callback(reg | 0x8000_0000) else {
                    return NAPI_INVALID_ARG;
                };
                let _ = Reflect::set(&descriptor, &JsValue::from_str("get"), &getter);
                let _ = Reflect::set(&descriptor, &JsValue::from_str("set"), &setter);
            }
            _ => return NAPI_INVALID_ARG,
        }

        if let Err(error) = Reflect::define_property(&object, &key, &descriptor) {
            if let Ok(state) = unsafe { env_mut(env) } {
                state.last_exception = Some(error);
            }
            return NAPI_PENDING_EXCEPTION;
        }
    }
    NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_define_class(
    env: SnapiEnv,
    utf8name: *const i8,
    name_len: u32,
    ctor_reg_id: u32,
    prop_count: u32,
    prop_names: *const *const i8,
    prop_name_ids: *const u32,
    prop_types: *const u32,
    prop_value_ids: *const u32,
    prop_method_reg_ids: *const u32,
    prop_getter_reg_ids: *const u32,
    prop_setter_reg_ids: *const u32,
    prop_attributes: *const i32,
    out_id: *mut u32,
) -> i32 {
    let mut ctor_id = 0;
    let status =
        unsafe { snapi_bridge_create_function(env, utf8name, name_len, ctor_reg_id, &mut ctor_id) };
    if status != NAPI_OK {
        return status;
    }
    let (constructor, prototype) = {
        let Ok(state) = (unsafe { env_mut(env) }) else {
            return NAPI_INVALID_ARG;
        };
        let Some(ctor) = state.get(ctor_id).cloned() else {
            return NAPI_INVALID_ARG;
        };
        match Reflect::get(&ctor, &JsValue::from_str("prototype")) {
            Ok(value) => (ctor, value),
            Err(error) => {
                state.last_exception = Some(error);
                return NAPI_PENDING_EXCEPTION;
            }
        }
    };
    for index in 0..prop_count as usize {
        let attrs = if prop_attributes.is_null() {
            0
        } else {
            unsafe { *prop_attributes.add(index) }
        };
        let target = if attrs & 1024 != 0 {
            &constructor
        } else {
            &prototype
        };
        let status = unsafe {
            define_properties_impl(
                env,
                target,
                1,
                if prop_names.is_null() {
                    ptr::null()
                } else {
                    prop_names.add(index)
                },
                if prop_name_ids.is_null() {
                    ptr::null()
                } else {
                    prop_name_ids.add(index)
                },
                if prop_types.is_null() {
                    ptr::null()
                } else {
                    prop_types.add(index)
                },
                if prop_value_ids.is_null() {
                    ptr::null()
                } else {
                    prop_value_ids.add(index)
                },
                if prop_method_reg_ids.is_null() {
                    ptr::null()
                } else {
                    prop_method_reg_ids.add(index)
                },
                if prop_getter_reg_ids.is_null() {
                    ptr::null()
                } else {
                    prop_getter_reg_ids.add(index)
                },
                if prop_setter_reg_ids.is_null() {
                    ptr::null()
                } else {
                    prop_setter_reg_ids.add(index)
                },
                if prop_attributes.is_null() {
                    ptr::null()
                } else {
                    prop_attributes.add(index)
                },
            )
        };
        if status != NAPI_OK {
            return status;
        }
    }
    unsafe { write(out_id, ctor_id) }.map_or_else(|err| err, |()| NAPI_OK)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_define_properties(
    env: SnapiEnv,
    obj_id: u32,
    prop_count: u32,
    prop_names: *const *const i8,
    prop_name_ids: *const u32,
    prop_types: *const u32,
    prop_value_ids: *const u32,
    prop_method_reg_ids: *const u32,
    prop_getter_reg_ids: *const u32,
    prop_setter_reg_ids: *const u32,
    prop_attributes: *const i32,
) -> i32 {
    let object = {
        let Ok(state) = (unsafe { env_mut(env) }) else {
            return NAPI_INVALID_ARG;
        };
        let Some(object) = state.get(obj_id).cloned() else {
            return NAPI_INVALID_ARG;
        };
        object
    };
    unsafe {
        define_properties_impl(
            env,
            &object,
            prop_count,
            prop_names,
            prop_name_ids,
            prop_types,
            prop_value_ids,
            prop_method_reg_ids,
            prop_getter_reg_ids,
            prop_setter_reg_ids,
            prop_attributes,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapi_bridge_dispose() {
    let _ = ();
    ()
}
