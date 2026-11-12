#include "unofficial_napi.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <thread>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <memory>
#include <limits>
#include <mutex>
#include <new>
#include <optional>
#include <random>
#include <sstream>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <libplatform/libplatform.h>
#include <v8.h>
#include <v8-profiler.h>

#include "internal/node_v8_default_flags.h"
#include "internal/napi_v8_env.h"
#include "internal/napi_serdes_context.h"
#include "internal/unofficial_napi_bridge.h"
#include "unofficial_napi_error_utils.h"
#include "edge_v8_platform.h"

struct unofficial_napi_profile__ {
  unofficial_napi_profile_kind kind = unofficial_napi_profile_cpu;
  uint32_t provider_id = 0;
};

namespace {

struct SharedRuntime {
  std::unique_ptr<EdgeV8Platform> platform;
  std::string engine_flags;
  uint32_t refcount = 0;
};

class TrackingArrayBufferAllocator;

struct UnofficialEnvScope {
  v8::Isolate* isolate = nullptr;
  std::shared_ptr<TrackingArrayBufferAllocator> allocator;
  std::optional<v8::Isolate::Scope> isolate_scope;
  std::optional<v8::HandleScope> handle_scope;
  std::optional<v8::Global<v8::Context>> context;
  std::optional<v8::Context::Scope> context_scope;
  napi_env env = nullptr;

  explicit UnofficialEnvScope(
      v8::Isolate* isolate_in,
      std::shared_ptr<TrackingArrayBufferAllocator> allocator_in)
      : isolate(isolate_in), allocator(std::move(allocator_in)) {
    isolate_scope.emplace(isolate_in);
    handle_scope.emplace(isolate_in);
  }

  ~UnofficialEnvScope() {
    if (context.has_value()) {
      context->Reset();
    }
    context_scope.reset();
    handle_scope.reset();
    isolate_scope.reset();
  }
};

struct PrepareStackTraceContextCallback {
  v8::Global<v8::Context> context;
  v8::Global<v8::Function> callback;
};

struct PrepareStackTraceState {
  v8::Global<v8::Function> principal_callback;
  std::vector<PrepareStackTraceContextCallback> context_callbacks;
};

std::mutex g_runtime_mu;
// iwci patch (#1021): set while this thread holds `g_runtime_mu`, so the
// out-of-memory handler knows whether waiting for it could ever end. A
// trivial type: nothing is registered to run at thread exit.
thread_local bool t_holds_runtime_mu = false;

// iwci patch (#1021): the only way `g_runtime_mu` is taken, so the flag
// above is never wrong.
class RuntimeLock {
 public:
  RuntimeLock() : lock_(g_runtime_mu) { t_holds_runtime_mu = true; }
  ~RuntimeLock() { t_holds_runtime_mu = false; }
  RuntimeLock(const RuntimeLock&) = delete;
  RuntimeLock& operator=(const RuntimeLock&) = delete;

 private:
  std::lock_guard<std::mutex> lock_;
};
// Deliberately heap-allocated and never freed: process exit (std::process::exit
// in the wasmer CLI, or exit() in any embedder) runs static destructors on the
// main thread while env teardown may still be running on another thread.
// Destroying the platform / these registries in that window is a use-after-free
// for the teardown thread (Isolate::Delete touches the platform's page
// allocator and tracing controller). The OS reclaims everything at _exit.
SharedRuntime& g_runtime = *new SharedRuntime();
std::unordered_map<v8::Isolate*, napi_env>& g_env_by_isolate =
    *new std::unordered_map<v8::Isolate*, napi_env>();
std::unordered_map<v8::Isolate*, uint64_t>& g_hash_seeds =
    *new std::unordered_map<v8::Isolate*, uint64_t>();
std::unordered_map<v8::Isolate*, v8::Global<v8::Function>>& g_promise_reject_callbacks =
    *new std::unordered_map<v8::Isolate*, v8::Global<v8::Function>>();
std::unordered_map<v8::Isolate*, std::array<v8::Global<v8::Function>, 4>>& g_promise_hooks =
    *new std::unordered_map<v8::Isolate*, std::array<v8::Global<v8::Function>, 4>>();
std::unordered_map<napi_env, PrepareStackTraceState>& g_prepare_stack_trace_callbacks =
    *new std::unordered_map<napi_env, PrepareStackTraceState>();
std::unordered_map<v8::ArrayBuffer::Allocator*, std::shared_ptr<TrackingArrayBufferAllocator>>&
    g_tracking_allocators = *new std::unordered_map<v8::ArrayBuffer::Allocator*,
                                                    std::shared_ptr<TrackingArrayBufferAllocator>>();

struct FatalErrorCallbacks {
  unofficial_napi_fatal_error_callback fatal = nullptr;
  unofficial_napi_oom_error_callback oom = nullptr;
};

std::unordered_map<v8::Isolate*, FatalErrorCallbacks>& g_fatal_error_callbacks =
    *new std::unordered_map<v8::Isolate*, FatalErrorCallbacks>();

struct NearHeapLimitCallbackState {
  unofficial_napi_near_heap_limit_callback callback = nullptr;
  void* data = nullptr;
};

std::unordered_map<v8::Isolate*, NearHeapLimitCallbackState>& g_near_heap_limit_callbacks =
    *new std::unordered_map<v8::Isolate*, NearHeapLimitCallbackState>();

// iwci patch (#972): confining V8's fatal out-of-memory to one isolate.
//
// Every isolate of the process shares it with every CI job, and V8 ends the
// process when an isolate runs out of heap where it cannot recover (an
// allocation on a background compile thread that still fails after its
// garbage collections, or one bigger than the limit leaves), so one job took
// every job down. V8 calls the isolate's OOM handler first and aborts only if
// it returns, so for an isolate whose host budgets it (its near-heap-limit
// data is the host's), the handler tells the host, stops the isolate's
// JavaScript, and never returns: the thread that ran out is parked for good,
// the isolate is abandoned, never disposed, and the host ends the job. That
// keeps whatever the thread holds of that isolate held, which is only that
// isolate's; it costs the thread (a V8 worker or the job's own) and the
// isolate's memory for the life of the process.
//
// `g_oom_mu` guards these sets and is never held while calling into V8. The
// host's data lives until the env is released, which erases it here under
// the same lock first.
std::mutex g_oom_mu;
std::unordered_map<v8::Isolate*, const void*>& g_oom_host_data =
    *new std::unordered_map<v8::Isolate*, const void*>();
// Isolates abandoned by a parked thread: never disposed.
std::unordered_set<v8::Isolate*>& g_lost_isolates =
    *new std::unordered_set<v8::Isolate*>();
// iwci patch (#990): the threads parked for good, and how many of those were
// V8's own worker threads (no isolate current), which its pool never gets
// back. For `snapi_bridge_out_of_memory_losses`.
uint64_t g_parked_threads = 0;
uint64_t g_parked_worker_threads = 0;
// Isolates being disposed. Dispose joins the isolate's background work under
// `g_isolate_lifecycle_mu`, which every isolate creation takes, so a thread
// parked for one of these would stop Node in every job for good: there the
// handler lets V8 abort as before.
std::unordered_set<v8::Isolate*>& g_disposing_isolates =
    *new std::unordered_set<v8::Isolate*>();
// Set while this thread holds `g_isolate_lifecycle_mu` (isolate creation or
// disposal), for the same reason.
thread_local bool t_in_isolate_lifecycle = false;
std::atomic<EdgeV8Platform*> g_oom_platform{nullptr};

struct InterruptRequest {
  napi_env env = nullptr;
  unofficial_napi_interrupt_callback callback = nullptr;
  void* data = nullptr;
};

struct ProfilerState {
  v8::CpuProfiler* cpu_profiler = nullptr;
  std::vector<unofficial_napi_profile> active_profiles;
};

std::unordered_map<napi_env, ProfilerState>& g_profiler_states =
    *new std::unordered_map<napi_env, ProfilerState>();

class StringOutputStream final : public v8::OutputStream {
 public:
  WriteResult WriteAsciiChunk(char* data, int size) override {
    if (data != nullptr && size > 0) output_.append(data, size);
    return kContinue;
  }

  void EndOfStream() override {}

  std::string TakeOutput() { return std::move(output_); }

 private:
  std::string output_;
};

napi_status CreateExternalUtf8Bytes(napi_env env,
                                    std::string&& bytes,
                                    napi_value* result) {
  if (env == nullptr || result == nullptr) return napi_invalid_arg;
  auto* owner = new (std::nothrow) std::string(std::move(bytes));
  if (owner == nullptr) return napi_generic_failure;
  if (owner->empty()) {
    delete owner;
    napi_value arraybuffer = nullptr;
    napi_status status = napi_create_arraybuffer(env, 0, nullptr, &arraybuffer);
    if (status != napi_ok) return status;
    return napi_create_typedarray(
        env, napi_uint8_array, 0, arraybuffer, 0, result);
  }
  napi_value arraybuffer = nullptr;
  napi_status status = napi_create_external_arraybuffer(
      env,
      owner->data(),
      owner->size(),
      [](napi_env, void*, void* hint) {
        delete static_cast<std::string*>(hint);
      },
      owner,
      &arraybuffer);
  if (status != napi_ok) {
    delete owner;
    return status;
  }
  return napi_create_typedarray(
      env, napi_uint8_array, owner->size(), arraybuffer, 0, result);
}

void DisposeProfilerState(napi_env env, ProfilerState* state) {
  if (env == nullptr || env->isolate == nullptr || state == nullptr) return;
  bool heap_profile_started = false;
  for (unofficial_napi_profile profile_session : state->active_profiles) {
    if (profile_session == nullptr) continue;
    if (profile_session->kind == unofficial_napi_profile_cpu &&
        state->cpu_profiler != nullptr) {
      if (v8::CpuProfile* profile =
              state->cpu_profiler->Stop(profile_session->provider_id)) {
        profile->Delete();
      }
    } else if (profile_session->kind == unofficial_napi_profile_heap) {
      heap_profile_started = true;
    }
    delete profile_session;
  }
  state->active_profiles.clear();
  if (heap_profile_started) {
    env->isolate->GetHeapProfiler()->StopSamplingHeapProfiler();
  }
  if (state->cpu_profiler != nullptr) {
    state->cpu_profiler->Dispose();
    state->cpu_profiler = nullptr;
  }
}

ProfilerState& EnsureProfilerState(napi_env env) {
  return g_profiler_states[env];
}

uint64_t GenerateHashSeed() {
  try {
    std::random_device random_device;
    const uint64_t high = static_cast<uint64_t>(random_device());
    const uint64_t low = static_cast<uint64_t>(random_device());
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    const uint64_t monotonic_ticks = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(now).count());
    const uint64_t mixed = (high << 32) ^ low ^ monotonic_ticks;
    if (mixed != 0) return mixed;
  } catch (...) {
    // Fall back below if entropy is unavailable in this runtime.
  }
  return 1;
}

void AppendEscapedJsonString(std::string* out, std::string_view input) {
  if (out == nullptr) return;
  out->push_back('"');
  for (unsigned char ch : input) {
    switch (ch) {
      case '"':
        out->append("\\\"");
        break;
      case '\\':
        out->append("\\\\");
        break;
      case '\b':
        out->append("\\b");
        break;
      case '\f':
        out->append("\\f");
        break;
      case '\n':
        out->append("\\n");
        break;
      case '\r':
        out->append("\\r");
        break;
      case '\t':
        out->append("\\t");
        break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out->append(buffer);
        } else {
          out->push_back(static_cast<char>(ch));
        }
    }
  }
  out->push_back('"');
}

template <typename T>
void AppendJsonNumber(std::string* out, T value) {
  if (out == nullptr) return;
  std::ostringstream stream;
  stream << value;
  out->append(stream.str());
}

void BuildHeapProfileNode(v8::Isolate* isolate,
                          const v8::AllocationProfile::Node* profile_node,
                          std::string* out) {
  if (out == nullptr) return;
  size_t self_size = 0;
  for (const auto& allocation : profile_node->allocations) {
    self_size += allocation.size * allocation.count;
  }

  out->push_back('{');
  out->append("\"selfSize\":");
  AppendJsonNumber(out, self_size);
  out->append(",\"id\":");
  AppendJsonNumber(out, profile_node->node_id);
  out->append(",\"callFrame\":{");
  out->append("\"scriptId\":");
  AppendJsonNumber(out, profile_node->script_id);
  out->append(",\"lineNumber\":");
  AppendJsonNumber(out, profile_node->line_number - 1);
  out->append(",\"columnNumber\":");
  AppendJsonNumber(out, profile_node->column_number - 1);
  v8::String::Utf8Value fn_name(isolate, profile_node->name);
  v8::String::Utf8Value script_name(isolate, profile_node->script_name);
  out->append(",\"functionName\":");
  AppendEscapedJsonString(out, *fn_name ? *fn_name : "");
  out->append(",\"url\":");
  AppendEscapedJsonString(out, *script_name ? *script_name : "");
  out->append("},\"children\":[");
  bool first = true;
  for (const auto* child : profile_node->children) {
    if (!first) out->push_back(',');
    BuildHeapProfileNode(isolate, child, out);
    first = false;
  }
  out->append("]}");
}

bool SerializeHeapProfile(v8::Isolate* isolate, std::string* out) {
  if (isolate == nullptr || out == nullptr) return false;
  v8::HeapProfiler* profiler = isolate->GetHeapProfiler();
  std::unique_ptr<v8::AllocationProfile> profile(profiler->GetAllocationProfile());
  if (!profile) return false;

  out->clear();
  out->append("{\"samples\":[");
  bool first = true;
  for (const auto& sample : profile->GetSamples()) {
    if (!first) out->push_back(',');
    out->append("{\"size\":");
    AppendJsonNumber(out, sample.size * sample.count);
    out->append(",\"nodeId\":");
    AppendJsonNumber(out, sample.node_id);
    out->append(",\"ordinal\":");
    AppendJsonNumber(out, static_cast<double>(sample.sample_id));
    out->push_back('}');
    first = false;
  }
  out->append("],\"head\":");
  BuildHeapProfileNode(isolate, profile->GetRootNode(), out);
  out->push_back('}');
  return true;
}

void ResetPrepareStackTraceState(PrepareStackTraceState* state) {
  if (state == nullptr) return;
  state->principal_callback.Reset();
  for (auto& entry : state->context_callbacks) {
    entry.context.Reset();
    entry.callback.Reset();
  }
  state->context_callbacks.clear();
}

v8::Local<v8::Function> LookupPrepareStackTraceCallback(napi_env env,
                                                        v8::Local<v8::Context> context) {
  if (env == nullptr || env->isolate == nullptr || context.IsEmpty()) {
    return v8::Local<v8::Function>();
  }

  auto state_it = g_prepare_stack_trace_callbacks.find(env);
  if (state_it == g_prepare_stack_trace_callbacks.end()) {
    return v8::Local<v8::Function>();
  }

  PrepareStackTraceState& state = state_it->second;
  v8::Local<v8::Context> principal_context = env->context();
  const bool use_principal_callback =
      !principal_context.IsEmpty() &&
      (context == principal_context || NapiV8IsContextifyContext(env, context));

  if (use_principal_callback) {
    return state.principal_callback.Get(context->GetIsolate());
  }

  for (const auto& entry : state.context_callbacks) {
    v8::Local<v8::Context> candidate = entry.context.Get(context->GetIsolate());
    if (!candidate.IsEmpty() && candidate == context) {
      return entry.callback.Get(context->GetIsolate());
    }
  }

  return state.principal_callback.Get(context->GetIsolate());
}

v8::MaybeLocal<v8::Value> NapiPrepareStackTraceCallback(v8::Local<v8::Context> context,
                                                        v8::Local<v8::Value> exception,
                                                        v8::Local<v8::Array> trace) {
  napi_env env = nullptr;
  {
    RuntimeLock lock;
    auto env_it = g_env_by_isolate.find(context->GetIsolate());
    if (env_it != g_env_by_isolate.end()) {
      env = env_it->second;
    }
  }

  if (env == nullptr) {
    return exception->ToString(context);
  }

  v8::Local<v8::Function> callback;
  {
    RuntimeLock lock;
    callback = LookupPrepareStackTraceCallback(env, context);
  }

  if (callback.IsEmpty()) {
    return exception->ToString(context);
  }

  v8::TryCatch try_catch(context->GetIsolate());
  v8::Local<v8::Value> argv[3] = {
      context->Global(),
      exception,
      trace,
  };
  v8::MaybeLocal<v8::Value> result =
      callback->Call(context, v8::Undefined(context->GetIsolate()), 3, argv);
  if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
    try_catch.ReThrow();
  }
  return result;
}

bool IsEnvThreadEntered(napi_env env) {
  return env != nullptr && env->isolate != nullptr && v8::Isolate::GetCurrent() == env->isolate;
}

size_t NearHeapLimitCallback(void* raw_env,
                             size_t current_heap_limit,
                             size_t initial_heap_limit) {
  napi_env env = static_cast<napi_env>(raw_env);
  v8::Isolate* isolate = env != nullptr ? env->isolate : nullptr;
  if (isolate == nullptr) {
    return current_heap_limit;
  }
  NearHeapLimitCallbackState state;
  {
    RuntimeLock lock;
    auto callback_it = g_near_heap_limit_callbacks.find(isolate);
    if (callback_it != g_near_heap_limit_callbacks.end()) {
      state = callback_it->second;
    }
  }
  if (state.callback == nullptr) {
    return current_heap_limit;
  }
  return state.callback(env, state.data, current_heap_limit, initial_heap_limit);
}

// iwci patch (#1021): an isolate's near-heap-limit callback from its env's
// release on: no JavaScript runs any more, so the heap only has to finish
// collecting and tear down. Grants room in steps, uncharged, up to the
// limit its data encodes (the heap's at release plus
// `kTeardownHeapSlackMax`).
constexpr size_t kTeardownHeapSlackStep = 32u * 1024 * 1024;
constexpr size_t kTeardownHeapSlackMax = 128u * 1024 * 1024;

size_t TeardownNearHeapLimitCallback(void* data,
                                     size_t current_heap_limit,
                                     size_t /*initial_heap_limit*/) {
  const size_t cap = static_cast<size_t>(reinterpret_cast<uintptr_t>(data));
  if (current_heap_limit >= cap) return current_heap_limit;
  return std::min(cap, current_heap_limit + kTeardownHeapSlackStep);
}

// iwci patch (#1063): every isolate of the process allocates its heap from
// one pointer-compression cage, which the host accounts for: a budgeted
// isolate reports the heap it has committed after each garbage collection,
// on its own thread, to the host data its near-heap-limit callback has.
// Installed and removed with that callback; the data is looked up as that
// callback does, so a lost isolate's, which the host frees, is never read.
extern "C" __attribute__((weak)) void napi_host_heap_committed(
    const void* /*data*/, size_t /*committed*/, int /*full*/) {}

void HeapCommittedCallback(v8::Isolate* isolate,
                           v8::GCType type,
                           v8::GCCallbackFlags /*flags*/,
                           void* /*env*/) {
  void* data = nullptr;
  {
    RuntimeLock lock;
    auto it = g_near_heap_limit_callbacks.find(isolate);
    if (it != g_near_heap_limit_callbacks.end()) data = it->second.data;
  }
  if (data == nullptr) return;
  v8::HeapStatistics heap;
  isolate->GetHeapStatistics(&heap);
  napi_host_heap_committed(
      data, heap.total_heap_size(),
      (type & v8::kGCTypeMarkSweepCompact) != 0 ? 1 : 0);
}

// Rust-exported guest-heap hooks (see guest_heap.rs). When a guest-heap
// context is installed, every V8 backing store is allocated inside the guest's
// linear memory so guest and host share buffer bytes directly. `free` returns
// nonzero when it owned (and handled) the pointer; zero means the allocation
// predates the context (mixed provenance) and must go to the legacy backing
// allocator. Weak fallbacks keep embedders without the Rust host (e.g. the
// native edgejs build) linking; no context is ever installed there.
extern "C" __attribute__((weak)) void* napi_host_guest_heap_alloc(
    const void* /*ctx*/, size_t /*length*/, int /*zero*/) {
  return nullptr;
}
extern "C" __attribute__((weak)) int napi_host_guest_heap_free(
    const void* /*ctx*/, void* /*data*/, size_t /*length*/) {
  return 0;
}
extern "C" __attribute__((weak)) void napi_host_guest_heap_release(
    void* /*ctx*/) {}
// iwci patch (#972): the host's record that V8 ran out of memory in an
// isolate it budgets (budget.rs). `data` is the isolate's near-heap-limit
// data.
extern "C" __attribute__((weak)) void napi_host_isolate_out_of_memory(
    const void* /*data*/) {}

class TrackingArrayBufferAllocator final : public v8::ArrayBuffer::Allocator {
 public:
  TrackingArrayBufferAllocator()
      : backing_(v8::ArrayBuffer::Allocator::NewDefaultAllocator()) {}

  ~TrackingArrayBufferAllocator() override {
    unofficial_napi_guest_heap guest_heap =
        guest_heap_.load(std::memory_order_acquire);
    if (guest_heap != nullptr) {
      napi_host_guest_heap_release(guest_heap);
    }
    delete backing_;
  }

  void* Allocate(size_t length) override { return AllocateImpl(length, true); }

  void* AllocateUninitialized(size_t length) override {
    return AllocateImpl(length, false);
  }

  void Free(void* data, size_t length) override {
    unofficial_napi_guest_heap guest_heap =
        guest_heap_.load(std::memory_order_acquire);
    if (guest_heap != nullptr && data != nullptr &&
        napi_host_guest_heap_free(guest_heap, data, length) != 0) {
      // Guest-heap provenance: no external-budget uncharge (those bytes were
      // never charged; they are wasm linear memory).
      total_mem_usage_.fetch_sub(length, std::memory_order_relaxed);
      return;
    }
    if (data != nullptr) {
      total_mem_usage_.fetch_sub(length, std::memory_order_relaxed);
    }
    if (backing_ != nullptr) {
      backing_->Free(data, length);
    }
  }

  size_t MaxAllocationSize() const override {
    size_t backing_max = backing_ != nullptr
                             ? backing_->MaxAllocationSize()
                             : v8::ArrayBuffer::Allocator::MaxAllocationSize();
    if (guest_heap_.load(std::memory_order_acquire) != nullptr) {
      // Guest-heap backing stores live in a 32-bit address space.
      constexpr size_t kGuestHeapMax = 0x7fff0000u;
      return backing_max < kGuestHeapMax ? backing_max : kGuestHeapMax;
    }
    return backing_max;
  }

  v8::PageAllocator* GetPageAllocator() override {
    return backing_ != nullptr ? backing_->GetPageAllocator() : nullptr;
  }

  uint64_t total_mem_usage() const {
    return total_mem_usage_.load(std::memory_order_relaxed);
  }

  // Install the guest-heap context: from now on every backing store is
  // allocated inside the guest's linear memory. Ownership transfers to the
  // allocator, which releases it in its destructor.
  void set_guest_heap(unofficial_napi_guest_heap guest_heap) {
    guest_heap_.store(guest_heap, std::memory_order_release);
  }

 private:
  void* AllocateImpl(size_t length, bool zeroed) {
    unofficial_napi_guest_heap guest_heap =
        guest_heap_.load(std::memory_order_acquire);
    if (guest_heap != nullptr) {
      // Guest-heap path. The claimed pages are already charged as wasm linear
      // memory, so the external budget is deliberately not consulted. On
      // failure return null (V8 throws RangeError); never fall back to host
      // memory, which the guest could not address.
      void* data = napi_host_guest_heap_alloc(
          guest_heap, length, zeroed ? 1 : 0);
      if (data != nullptr) {
        total_mem_usage_.fetch_add(length, std::memory_order_relaxed);
      }
      return data;
    }
    // No guest-heap context: this is the native (non-guest) embedder, which
    // has no budget concept for this allocator. Plain host allocation.
    void* data = nullptr;
    if (backing_ != nullptr) {
      data = zeroed ? backing_->Allocate(length)
                    : backing_->AllocateUninitialized(length);
    }
    if (data != nullptr) {
      total_mem_usage_.fetch_add(length, std::memory_order_relaxed);
    }
    return data;
  }

  v8::ArrayBuffer::Allocator* backing_ = nullptr;
  std::atomic<uint64_t> total_mem_usage_ {0};
  std::atomic<unofficial_napi_guest_heap> guest_heap_ {nullptr};
};

void ApplyNodeIsolateCreateParams(
    v8::Isolate::CreateParams* params,
    const unofficial_napi_env_create_options* options) {
  if (params == nullptr || options == nullptr) return;

  const uint64_t constrained_memory = options->constrained_memory;
  const uint64_t total_memory =
      constrained_memory > 0
          ? std::min<uint64_t>(options->total_memory, constrained_memory)
          : options->total_memory;
  if (total_memory > 0 &&
      params->constraints.max_old_generation_size_in_bytes() == 0) {
    params->constraints.ConfigureDefaults(total_memory, 0);
  }
}

v8::IsolateGroup GetOrCreateIsolateGroup() {
  if (v8::IsolateGroup::CanCreateNewGroups()) {
    return v8::IsolateGroup::Create();
  }
  return v8::IsolateGroup::GetDefault();
}

// iwci patch (from wasmerio/napi 832e57ec): EdgeV8Platform keys per-isolate
// state by address. Envs on different threads create and release isolates at
// the same time, so a new isolate must not be allocated (possibly at a
// just-freed address) and registered while another isolate is between
// Dispose() and unregistration. The bridge's `g_mu` used to serialize these;
// it no longer covers env creation or release. Only construction and V8
// disposal take this lock: not execution, env teardown or the wait for the
// platform's pending tasks.
std::mutex g_isolate_lifecycle_mu;

// iwci patch (#972): marks this thread as holding `g_isolate_lifecycle_mu`.
struct InIsolateLifecycle {
  InIsolateLifecycle() { t_in_isolate_lifecycle = true; }
  ~InIsolateLifecycle() { t_in_isolate_lifecycle = false; }
};

void OOMErrorCallback(const char* location, const v8::OOMDetails& details);

v8::Isolate* CreateIsolateForEnv(EdgeV8Platform* platform,
                                 const v8::Isolate::CreateParams& params) {
  std::lock_guard<std::mutex> lock(g_isolate_lifecycle_mu);
  InIsolateLifecycle in_lifecycle;
  v8::Isolate* isolate = v8::Isolate::Allocate(GetOrCreateIsolateGroup());
  if (isolate == nullptr) return nullptr;
  if (platform != nullptr && !platform->RegisterIsolate(isolate)) {
    isolate->Dispose();
    return nullptr;
  }
  v8::Isolate::Initialize(isolate, params);
  // iwci patch (#972): from the start, not only once an embedder attaches
  // hooks (this bridge attaches none of its own).
  isolate->SetOOMErrorHandler(OOMErrorCallback);
  return isolate;
}

struct PlatformShutdownWaiter {
  std::mutex mutex;
  std::condition_variable cv;
  bool finished = false;
};

void OnPlatformShutdownFinished(void* data) {
  auto* waiter = static_cast<PlatformShutdownWaiter*>(data);
  if (waiter == nullptr) return;
  {
    std::lock_guard<std::mutex> lock(waiter->mutex);
    waiter->finished = true;
  }
  waiter->cv.notify_all();
}

void WaitForPlatformShutdown(PlatformShutdownWaiter* waiter,
                             void* /*shutdown_pump_handle*/) {
  if (waiter == nullptr) return;
  std::unique_lock<std::mutex> lock(waiter->mutex);
  while (!waiter->finished) {
    waiter->cv.wait_for(lock, std::chrono::milliseconds(1));
  }
}

void DisposeIsolateAndWait(EdgeV8Platform* platform,
                           v8::Isolate* isolate,
                           void* shutdown_pump_handle = nullptr) {
  if (isolate == nullptr) return;

  PlatformShutdownWaiter waiter;
  {
    std::lock_guard<std::mutex> lock(g_isolate_lifecycle_mu);
    InIsolateLifecycle in_lifecycle;
    if (platform != nullptr) {
      platform->AddIsolateFinishedCallback(
          isolate, OnPlatformShutdownFinished, &waiter);
      platform->DisposeIsolate(isolate);
    } else {
      waiter.finished = true;
      isolate->Dispose();
    }
  }
  WaitForPlatformShutdown(&waiter, shutdown_pump_handle);
}

void ApplyDefaultV8Flags() {
  v8::V8::SetFlagsFromString(
      kNodeDefaultShippingV8Flags,
      static_cast<int>(sizeof(kNodeDefaultShippingV8Flags) - 1));
}

void FatalErrorCallback(const char* location, const char* message) {
  v8::Isolate* isolate = v8::Isolate::TryGetCurrent();
  if (isolate == nullptr) return;

  unofficial_napi_fatal_error_callback callback = nullptr;
  napi_env env = nullptr;
  {
    RuntimeLock lock;
    auto callback_it = g_fatal_error_callbacks.find(isolate);
    if (callback_it != g_fatal_error_callbacks.end()) {
      callback = callback_it->second.fatal;
    }
    auto env_it = g_env_by_isolate.find(isolate);
    if (env_it != g_env_by_isolate.end()) {
      env = env_it->second;
    }
  }
  if (callback != nullptr) {
    callback(env, location, message);
  }
}

// iwci patch (#972): the isolate V8 ran out of memory in, from the thread
// it calls the handler on: the job's own thread has it current, a V8 worker
// thread runs a task posted for it.
v8::Isolate* IsolateOutOfMemory() {
  v8::Isolate* isolate = v8::Isolate::TryGetCurrent();
  return isolate != nullptr ? isolate : EdgeV8Platform::CurrentWorkerIsolate();
}

// iwci patch (#972): see `g_oom_mu`. Returns only when the isolate cannot be
// confined, with why (#1021), and V8 then aborts the process as it always
// did: no isolate known on this thread, one the host does not budget (or
// not yet: it is still being created), or one being disposed.
const char* ConfineOutOfMemory(v8::Isolate* isolate,
                               const char* location,
                               const v8::OOMDetails& details) {
  if (isolate == nullptr) {
    return "no isolate is current on this thread and it runs no task the "
           "platform knows the isolate of";
  }
  // Parking here would hold `g_isolate_lifecycle_mu`, which every isolate
  // creation and disposal takes. Only the isolate being created (not yet
  // budgeted) or disposed (below) runs on such a thread.
  if (t_in_isolate_lifecycle) {
    return "this thread holds g_isolate_lifecycle_mu (creating or disposing "
           "an isolate)";
  }
  {
    std::lock_guard<std::mutex> lock(g_oom_mu);
    auto it = g_oom_host_data.find(isolate);
    // iwci patch (#1021): an isolate already abandoned stays confined after
    // its env is released, which erases its host data: another of its
    // threads (a background compile) can still run out.
    const bool lost = g_lost_isolates.count(isolate) != 0;
    if (it == g_oom_host_data.end() && !lost) {
      return "the host does not budget this isolate (or not yet: it is being "
             "created)";
    }
    if (g_disposing_isolates.count(isolate) != 0) {
      return "the isolate is being disposed, which waits for this thread";
    }
    g_lost_isolates.insert(isolate);
    g_parked_threads += 1;
    if (v8::Isolate::TryGetCurrent() == nullptr) g_parked_worker_threads += 1;
    // Under the lock: env release erases the data under it before the host
    // frees it.
    if (it != g_oom_host_data.end()) napi_host_isolate_out_of_memory(it->second);
  }
  // Thread-safe. When this is a worker thread, the isolate's own thread
  // stops running JavaScript and its event loop stops waiting for this
  // thread's task, so the program ends (the host ends the job anyway).
  isolate->TerminateExecution();
  if (EdgeV8Platform* platform = g_oom_platform.load(std::memory_order_acquire)) {
    platform->AbandonIsolate(isolate);
  }
  // iwci patch (#1021): V8 ran out of memory under `g_runtime_mu`, taken by
  // this thread (a global handle made under it). Every env creation takes
  // it, so it is let go here. The frame that took it never resumes, so its
  // guard never unlocks it again; the maps it guards are only changed by
  // whole container operations, which never call into V8, so they are
  // consistent between any two calls that can run out.
  if (t_holds_runtime_mu) {
    t_holds_runtime_mu = false;
    g_runtime_mu.unlock();
  }
  std::fprintf(stderr,
               "\n# V8 ran out of %s memory in isolate %p (%s%s%s).\n"
               "# Confined to its program: this thread is parked for good and "
               "the isolate abandoned.\n\n",
               details.is_heap_oom ? "JavaScript heap" : "process", static_cast<void*>(isolate),
               location != nullptr ? location : "",
               details.detail != nullptr ? ": " : "",
               details.detail != nullptr ? details.detail : "");
  std::fflush(stderr);
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
}

void OOMErrorCallback(const char* location, const v8::OOMDetails& details) {
  v8::Isolate* isolate = IsolateOutOfMemory();
  // V8 calls `ProcessOOMErrorCallback` next, which says why.
  if (isolate == nullptr) return;

  unofficial_napi_oom_error_callback callback = nullptr;
  napi_env env = nullptr;
  {
    // iwci patch (#1021): V8 can run out of memory in a thread that holds
    // `g_runtime_mu` (a global handle made under it), and that thread reads
    // the maps as it is. Any other holder lets go of it, so this waits for
    // as long as that takes. (#972 gave up after a second, taking a lock
    // still held as this thread's own; under load that was not.)
    std::optional<RuntimeLock> lock;
    if (!t_holds_runtime_mu) lock.emplace();
    auto callback_it = g_fatal_error_callbacks.find(isolate);
    if (callback_it != g_fatal_error_callbacks.end()) {
      callback = callback_it->second.oom;
    }
    auto env_it = g_env_by_isolate.find(isolate);
    if (env_it != g_env_by_isolate.end()) {
      env = env_it->second;
    }
  }
  if (callback != nullptr) {
    callback(env, location, details.is_heap_oom, details.detail);
  }
  // Returns only when it cannot confine, and then so does
  // `ProcessOOMErrorCallback`, which V8 calls next and which says why.
  (void)ConfineOutOfMemory(isolate, location, details);
}

// iwci patch (#972): process-wide, for what V8 reports without an isolate
// (V8::FatalProcessOutOfMemory(nullptr, ...) on a worker thread, a zone
// allocation for instance). With an isolate, V8 13.6 calls this after the
// isolate's own handler returns, and aborts once this returns too
// ("API fatal error handler returned after process out of memory").
void ProcessOOMErrorCallback(const char* location, const v8::OOMDetails& details) {
  v8::Isolate* isolate = IsolateOutOfMemory();
  const char* why = ConfineOutOfMemory(isolate, location, details);
  // iwci patch (#1021): the last thing before V8 aborts the process, so a
  // runner that went down this way says which case it was.
  std::fprintf(stderr,
               "\n# iwci: V8 ran out of %s memory (%s%s%s) in isolate %p on %s, "
               "and it could not be confined to its program: %s.\n\n",
               details.is_heap_oom ? "JavaScript heap" : "process",
               location != nullptr ? location : "",
               details.detail != nullptr ? ": " : "",
               details.detail != nullptr ? details.detail : "",
               static_cast<void*>(isolate),
               v8::Isolate::TryGetCurrent() != nullptr ? "a thread it is entered on"
                                                   : "a thread with no isolate entered",
               why);
  std::fflush(stderr);
}

napi_status ConfigureRuntime(const char* engine_flags,
                             size_t engine_flags_length) {
  if ((engine_flags_length > 0 && engine_flags == nullptr) ||
      engine_flags_length > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return napi_invalid_arg;
  }
  RuntimeLock lock;
  if (g_runtime.platform != nullptr) {
    return g_runtime.engine_flags.size() == engine_flags_length &&
                   (engine_flags_length == 0 ||
                    std::memcmp(g_runtime.engine_flags.data(), engine_flags,
                                engine_flags_length) == 0)
               ? napi_ok
               : napi_invalid_arg;
  }

  ApplyDefaultV8Flags();
  if (engine_flags_length > 0) {
    v8::V8::SetFlagsFromString(engine_flags,
                               static_cast<int>(engine_flags_length));
  }
  // iwci patch: no memory protection keys. On a CPU with PKU, V8 tags the
  // process-wide JS dispatch table with a protection key and grants access to
  // it in the PKRU register of the thread that first initialises V8, and of
  // threads that thread later creates. PKRU is per thread, so an isolate made
  // on a thread from an older pool (a second CI job's `node`) faulted reading
  // that table in Isolate::Init (SIGSEGV, PK set in the error code) and took
  // the whole runner down. Without the keys V8 protects those pages with
  // mprotect, which every thread sees the same. Set last, so no guest flag
  // can turn them back on.
  {
    static const char kNoPkeys[] = "--no-memory-protection-keys";
    v8::V8::SetFlagsFromString(kNoPkeys, static_cast<int>(sizeof(kNoPkeys) - 1));
  }
  // iwci patch (#970): no garbage collection of WebAssembly code. V8 13.6
  // keeps the compiled wasm-to-JS wrappers in one cache for the process,
  // and a lookup there adds a wrapper to the caller's WasmCodeRefScope
  // before it checks that the wrapper is dying. When a code GC cycle then
  // frees the wrapper on another isolate's thread, the scope frees it again
  // on its way out (WasmCode::DecrementRefCount on a deleted WasmCode) and
  // the process segfaults in WasmEngine::FreeDeadCode. It takes two isolates
  // on two threads, which is any two jobs here. V8 fixed the lookup in
  // 9b8ca54d5 (13.7); this V8 is prebuilt, so until it is newer the cycle
  // that frees a dying wrapper never runs. A stopgap: dead code then stays
  // until its module goes, and a dead wrapper for as long as the process
  // lives (vendor/README.md has the numbers). Set last, so no guest flag
  // can turn it back on.
  {
    static const char kNoWasmCodeGc[] = "--no-wasm-code-gc";
    v8::V8::SetFlagsFromString(kNoWasmCodeGc,
                               static_cast<int>(sizeof(kNoWasmCodeGc) - 1));
  }
  v8::V8::InitializeICUDefaultLocation("");
  v8::V8::InitializeExternalStartupData("");
  g_runtime.platform = EdgeV8Platform::Create();
  if (g_runtime.platform == nullptr) return napi_generic_failure;
  v8::V8::InitializePlatform(g_runtime.platform.get());
  v8::V8::Initialize();
  // iwci patch (#972)
  g_oom_platform.store(g_runtime.platform.get(), std::memory_order_release);
  v8::V8::SetFatalMemoryErrorCallback(ProcessOOMErrorCallback);
  g_runtime.engine_flags.assign(engine_flags_length > 0 ? engine_flags : "",
                                engine_flags_length);
  return napi_ok;
}

napi_status AcquireRuntime(EdgeV8Platform** platform_out) {
  if (platform_out == nullptr) return napi_invalid_arg;
  RuntimeLock lock;
  if (g_runtime.platform == nullptr) return napi_invalid_arg;
  g_runtime.refcount++;
  *platform_out = g_runtime.platform.get();
  return *platform_out != nullptr ? napi_ok : napi_generic_failure;
}

void ReleaseRuntime() {
  RuntimeLock lock;
  if (g_runtime.refcount == 0) return;
  g_runtime.refcount--;
  // Keep shared V8 runtime alive for process lifetime in tests to avoid
  // repeated Dispose/Initialize instability in embedded setups.
}

void PromiseRejectCallback(v8::PromiseRejectMessage message) {
  v8::Local<v8::Promise> promise = message.GetPromise();
  if (promise.IsEmpty()) return;

  v8::Isolate* isolate = promise->GetIsolate();
  napi_env env = nullptr;
  v8::Local<v8::Function> callback;
  {
    RuntimeLock lock;
    const auto env_it = g_env_by_isolate.find(isolate);
    if (env_it == g_env_by_isolate.end() || env_it->second == nullptr) return;
    env = env_it->second;
    const auto cb_it = g_promise_reject_callbacks.find(isolate);
    if (cb_it == g_promise_reject_callbacks.end() || cb_it->second.IsEmpty()) return;
    callback = cb_it->second.Get(isolate);
  }
  if (env == nullptr || callback.IsEmpty()) return;

  v8::PromiseRejectEvent event = message.GetEvent();
  v8::Local<v8::Value> value;
  switch (event) {
    case v8::kPromiseRejectWithNoHandler:
    case v8::kPromiseResolveAfterResolved:
    case v8::kPromiseRejectAfterResolved:
      value = message.GetValue();
      if (value.IsEmpty()) value = v8::Undefined(isolate);
      break;
    case v8::kPromiseHandlerAddedAfterReject:
      value = v8::Undefined(isolate);
      break;
    default:
      return;
  }

  const bool debug_promise_reject =
      std::getenv("EDGE_DEBUG_EXCEPTIONS") != nullptr &&
      std::getenv("EDGE_DEBUG_EXCEPTIONS")[0] != '\0' &&
      std::getenv("EDGE_DEBUG_EXCEPTIONS")[0] != '0';

  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);
  v8::TryCatch tc(isolate);
  if (debug_promise_reject) {
    v8::String::Utf8Value text(isolate, value);
    std::fprintf(stderr,
                 "[edge-pr] event=%d value=%s\n",
                 static_cast<int>(event),
                 *text != nullptr ? *text : "<unprintable>");
  }
  v8::Local<v8::Value> args[] = {
      v8::Integer::New(isolate, static_cast<int>(event)),
      promise,
      value};
  (void)callback->Call(context, v8::Undefined(isolate), 3, args);
  if (tc.HasCaught() && !tc.HasTerminated()) {
    // Match Node behavior: V8 expects this callback to return without a pending
    // exception. Print a best-effort diagnostic instead of scheduling it.
    std::fprintf(stderr, "Exception in PromiseRejectCallback:\n");
    v8::Local<v8::Value> caught = tc.Exception();
    v8::String::Utf8Value text(isolate, caught);
    if (*text != nullptr) {
      std::fprintf(stderr, "%s\n", *text);
    } else {
      std::fprintf(stderr, "<exception>\n");
    }
  }
}

bool IsNullishValue(v8::Local<v8::Value> value) {
  return value.IsEmpty() || value->IsUndefined() || value->IsNull();
}

bool GetPromiseHookFunction(napi_env env,
                            napi_value value,
                            v8::Local<v8::Function>* function_out) {
  if (env == nullptr || function_out == nullptr) return false;
  *function_out = v8::Local<v8::Function>();
  if (value == nullptr) return true;

  v8::Local<v8::Value> raw = napi_v8_unwrap_value(value);
  if (IsNullishValue(raw)) return true;
  if (!raw->IsFunction()) return false;

  *function_out = raw.As<v8::Function>();
  return true;
}

bool HasPromiseHooks(const std::array<v8::Global<v8::Function>, 4>& hooks) {
  for (const auto& hook : hooks) {
    if (!hook.IsEmpty()) return true;
  }
  return false;
}

#ifndef V8_ENABLE_JAVASCRIPT_PROMISE_HOOKS
size_t PromiseHookIndex(v8::PromiseHookType type) {
  switch (type) {
    case v8::PromiseHookType::kInit:
      return 0;
    case v8::PromiseHookType::kBefore:
      return 1;
    case v8::PromiseHookType::kAfter:
      return 2;
    case v8::PromiseHookType::kResolve:
      return 3;
    default:
      return 4;
  }
}

void PromiseHookCallback(v8::PromiseHookType type,
                         v8::Local<v8::Promise> promise,
                         v8::Local<v8::Value> parent) {
  v8::Isolate* isolate = promise->GetIsolate();
  napi_env env = nullptr;
  v8::Local<v8::Function> callback;
  {
    RuntimeLock lock;
    const auto env_it = g_env_by_isolate.find(isolate);
    if (env_it == g_env_by_isolate.end() || env_it->second == nullptr) return;
    env = env_it->second;

    const auto hooks_it = g_promise_hooks.find(isolate);
    if (hooks_it == g_promise_hooks.end()) return;

    const size_t index = PromiseHookIndex(type);
    if (index >= hooks_it->second.size() || hooks_it->second[index].IsEmpty()) return;
    callback = hooks_it->second[index].Get(isolate);
  }
  if (env == nullptr || callback.IsEmpty()) return;

  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context =
      isolate->InContext() ? isolate->GetCurrentContext() : env->context();
  if (context.IsEmpty()) return;
  std::optional<v8::Context::Scope> context_scope;
  if (!isolate->InContext()) {
    context_scope.emplace(context);
  }

  v8::TryCatch tc(isolate);
  tc.SetVerbose(false);
  v8::Local<v8::Value> args[] = {
      promise,
      parent.IsEmpty() ? v8::Undefined(isolate) : parent,
  };
  const int argc = type == v8::PromiseHookType::kInit ? 2 : 1;
  (void)callback->Call(context, v8::Undefined(isolate), argc, args);
  if (tc.HasCaught() && !tc.HasTerminated()) {
    tc.ReThrow();
  }
}
#endif

std::array<v8::Local<v8::Function>, 4> LookupPromiseHooksForContext(napi_env env,
                                                                    v8::Isolate* isolate) {
  std::array<v8::Local<v8::Function>, 4> hooks;
  if (env == nullptr || isolate == nullptr) return hooks;

  RuntimeLock lock;
  auto hooks_it = g_promise_hooks.find(isolate);
  if (hooks_it == g_promise_hooks.end()) return hooks;

  for (size_t i = 0; i < hooks.size(); ++i) {
    if (!hooks_it->second[i].IsEmpty()) {
      hooks[i] = hooks_it->second[i].Get(isolate);
    }
  }
  return hooks;
}

v8::Local<v8::String> OneByteString(v8::Isolate* isolate, const char* value) {
  return v8::String::NewFromUtf8(isolate, value, v8::NewStringType::kInternalized)
      .ToLocalChecked();
}

void ThrowTypeErrorWithCode(v8::Local<v8::Context> context,
                            v8::Isolate* isolate,
                            const char* code,
                            const char* message) {
  v8::Local<v8::Value> exception = v8::Exception::TypeError(OneByteString(isolate, message));
  if (exception->IsObject()) {
    (void)exception.As<v8::Object>()->Set(
        context, OneByteString(isolate, "code"), OneByteString(isolate, code));
  }
  isolate->ThrowException(exception);
}

v8::Local<v8::Object> CreateBufferObject(v8::Local<v8::Context> context,
                                         v8::Local<v8::ArrayBuffer> array_buffer,
                                         size_t offset,
                                         size_t length) {
  v8::Isolate* isolate = context->GetIsolate();
  v8::Local<v8::Object> global = context->Global();

  v8::Local<v8::Value> buffer_ctor_value;
  if (global->Get(context, OneByteString(isolate, "Buffer")).ToLocal(&buffer_ctor_value) &&
      buffer_ctor_value->IsObject()) {
    v8::Local<v8::Object> buffer_ctor = buffer_ctor_value.As<v8::Object>();
    v8::Local<v8::Value> from_value;
    if (buffer_ctor->Get(context, OneByteString(isolate, "from")).ToLocal(&from_value) &&
        from_value->IsFunction()) {
      v8::Local<v8::Value> argv[3] = {
          array_buffer,
          v8::Number::New(isolate, static_cast<double>(offset)),
          v8::Number::New(isolate, static_cast<double>(length)),
      };
      v8::Local<v8::Value> maybe_buffer;
      if (from_value.As<v8::Function>()->Call(context, buffer_ctor, 3, argv).ToLocal(&maybe_buffer) &&
          maybe_buffer->IsObject()) {
        return maybe_buffer.As<v8::Object>();
      }
    }
  }

  return v8::Uint8Array::New(array_buffer, offset, length);
}

bool ReadArrayBufferViewBytes(v8::Local<v8::Value> value,
                              const uint8_t** data_out,
                              size_t* size_out) {
  if (data_out == nullptr || size_out == nullptr || value.IsEmpty() || !value->IsArrayBufferView()) {
    return false;
  }
  v8::Local<v8::ArrayBufferView> view = value.As<v8::ArrayBufferView>();
  std::shared_ptr<v8::BackingStore> store = view->Buffer()->GetBackingStore();
  if (!store || store->Data() == nullptr) {
    *data_out = nullptr;
    *size_out = 0;
    return true;
  }
  *data_out = static_cast<const uint8_t*>(store->Data()) + view->ByteOffset();
  *size_out = view->ByteLength();
  return true;
}

}  // namespace

namespace v8impl::detail {

SerializerContext::SerializerContext(napi_env env, v8::Local<v8::Object> wrap)
    : env_(env), isolate_(env->isolate), serializer_(isolate_, this) {
  wrap_.Reset(isolate_, wrap);
  wrap_.SetWeak(this, WeakCallback, v8::WeakCallbackType::kParameter);
}

SerializerContext::~SerializerContext() {
  wrap_.Reset();
}

void SerializerContext::ThrowDataCloneError(v8::Local<v8::String> message) {
  v8::Local<v8::Context> context = env_->context();
  v8::Local<v8::Object> wrap = wrap_.Get(isolate_);

  v8::Local<v8::Value> get_data_clone_error;
  if (!wrap->Get(context, OneByteString(isolate_, "_getDataCloneError"))
           .ToLocal(&get_data_clone_error) ||
      !get_data_clone_error->IsFunction()) {
    isolate_->ThrowException(v8::Exception::Error(message));
    return;
  }

  v8::Local<v8::Value> argv[1] = {message};
  v8::Local<v8::Value> error;
  if (get_data_clone_error.As<v8::Function>()->Call(context, wrap, 1, argv).ToLocal(&error)) {
    isolate_->ThrowException(error);
  }
}

v8::Maybe<uint32_t> SerializerContext::GetSharedArrayBufferId(
    v8::Isolate* isolate,
    v8::Local<v8::SharedArrayBuffer> shared_array_buffer) {
  v8::Local<v8::Context> context = env_->context();
  v8::Local<v8::Object> wrap = wrap_.Get(isolate);

  v8::Local<v8::Value> hook;
  if (!wrap->Get(context, OneByteString(isolate, "_getSharedArrayBufferId")).ToLocal(&hook) ||
      !hook->IsFunction()) {
    return v8::ValueSerializer::Delegate::GetSharedArrayBufferId(isolate, shared_array_buffer);
  }

  v8::Local<v8::Value> argv[1] = {shared_array_buffer};
  v8::Local<v8::Value> id;
  if (!hook.As<v8::Function>()->Call(context, wrap, 1, argv).ToLocal(&id)) {
    return v8::Nothing<uint32_t>();
  }
  return id->Uint32Value(context);
}

v8::Maybe<bool> SerializerContext::WriteHostObject(v8::Isolate* isolate,
                                                   v8::Local<v8::Object> input) {
  v8::Local<v8::Context> context = env_->context();
  v8::Local<v8::Object> wrap = wrap_.Get(isolate);

  v8::Local<v8::Value> hook;
  if (!wrap->Get(context, OneByteString(isolate, "_writeHostObject")).ToLocal(&hook)) {
    return v8::Nothing<bool>();
  }
  if (!hook->IsFunction()) {
    return v8::ValueSerializer::Delegate::WriteHostObject(isolate, input);
  }

  v8::Local<v8::Value> argv[1] = {input};
  v8::Local<v8::Value> ret;
  if (!hook.As<v8::Function>()->Call(context, wrap, 1, argv).ToLocal(&ret)) {
    return v8::Nothing<bool>();
  }
  return v8::Just(true);
}

void SerializerContext::New(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    if (!args.IsConstructCall()) {
      ThrowTypeErrorWithCode(args.GetIsolate()->GetCurrentContext(),
                             isolate,
                             "ERR_CONSTRUCT_CALL_REQUIRED",
                             "Class constructor Serializer cannot be invoked without 'new'");
      return;
    }
    if (!args.Data()->IsExternal()) {
      isolate->ThrowException(v8::Exception::Error(
          OneByteString(isolate, "Internal serializer constructor state missing")));
      return;
    }

    auto* env = static_cast<napi_env>(v8::Local<v8::External>::Cast(args.Data())->Value());
    if (env == nullptr) {
      isolate->ThrowException(v8::Exception::Error(
          OneByteString(isolate, "Internal serializer environment missing")));
      return;
    }

    auto* ctx = env->allocate<SerializerContext>(env, args.This());
    args.This()->SetAlignedPointerInInternalField(0, ctx);
}

void SerializerContext::WriteHeader(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr) return;
    ctx->serializer_.WriteHeader();
}

void SerializerContext::WriteValue(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr) return;
    v8::Local<v8::Value> value = args.Length() >= 1 ? args[0] : v8::Undefined(ctx->isolate_);
    bool ret = false;
    if (ctx->serializer_.WriteValue(ctx->env_->context(), value).To(&ret)) {
      args.GetReturnValue().Set(ret);
    }
}

void SerializerContext::SetTreatArrayBufferViewsAsHostObjects(
    const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr) return;
    const bool value = args.Length() >= 1 && args[0]->BooleanValue(ctx->isolate_);
    ctx->serializer_.SetTreatArrayBufferViewsAsHostObjects(value);
}

void SerializerContext::ReleaseBuffer(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr) return;

    std::pair<uint8_t*, size_t> serialized = ctx->serializer_.Release();
    v8::Isolate* isolate = ctx->isolate_;
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Context> context = ctx->env_->context();
    v8::Context::Scope context_scope(context);

    auto backing_store = v8::ArrayBuffer::NewBackingStore(
        serialized.first,
        serialized.second,
        [](void* data, size_t, void*) { std::free(data); },
        nullptr);
    if (!backing_store) {
      std::free(serialized.first);
      return;
    }
    v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(isolate, std::move(backing_store));
    args.GetReturnValue().Set(CreateBufferObject(context, ab, 0, serialized.second));
}

void SerializerContext::TransferArrayBuffer(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr) return;
    if (args.Length() < 2) return;

    uint32_t id = 0;
    if (!args[0]->Uint32Value(ctx->env_->context()).To(&id)) return;

    if (!args[1]->IsArrayBuffer()) {
      ThrowTypeErrorWithCode(ctx->env_->context(),
                             ctx->isolate_,
                             "ERR_INVALID_ARG_TYPE",
                             "arrayBuffer must be an ArrayBuffer");
      return;
    }
    ctx->serializer_.TransferArrayBuffer(id, args[1].As<v8::ArrayBuffer>());
}

void SerializerContext::WriteUint32(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || args.Length() < 1) return;
    uint32_t value = 0;
    if (args[0]->Uint32Value(ctx->env_->context()).To(&value)) {
      ctx->serializer_.WriteUint32(value);
    }
}

void SerializerContext::WriteUint64(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || args.Length() < 2) return;
    uint32_t hi = 0;
    uint32_t lo = 0;
    if (!args[0]->Uint32Value(ctx->env_->context()).To(&hi) ||
        !args[1]->Uint32Value(ctx->env_->context()).To(&lo)) {
      return;
    }
    ctx->serializer_.WriteUint64((static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo));
}

void SerializerContext::WriteDouble(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || args.Length() < 1) return;
    double value = 0;
    if (args[0]->NumberValue(ctx->env_->context()).To(&value)) {
      ctx->serializer_.WriteDouble(value);
    }
}

void SerializerContext::WriteRawBytes(const v8::FunctionCallbackInfo<v8::Value>& args) {
    SerializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || args.Length() < 1) return;
    const uint8_t* data = nullptr;
    size_t size = 0;
    if (!ReadArrayBufferViewBytes(args[0], &data, &size)) {
      ThrowTypeErrorWithCode(ctx->env_->context(),
                             ctx->isolate_,
                             "ERR_INVALID_ARG_TYPE",
                             "source must be a TypedArray or a DataView");
      return;
    }
    ctx->serializer_.WriteRawBytes(data, size);
}

SerializerContext* SerializerContext::Unwrap(
    const v8::FunctionCallbackInfo<v8::Value>& args) {
    if (args.This().IsEmpty() || args.This()->InternalFieldCount() < 1) return nullptr;
    return static_cast<SerializerContext*>(args.This()->GetAlignedPointerFromInternalField(0));
}

void SerializerContext::WeakCallback(const v8::WeakCallbackInfo<SerializerContext>& info) {
    SerializerContext* context = info.GetParameter();
    if (context != nullptr && context->env_ != nullptr) {
      context->env_->release(context);
    }
}

DeserializerContext::DeserializerContext(napi_env env,
                                         v8::Local<v8::Object> wrap,
                                         v8::Local<v8::Value> buffer)
    : env_(env), isolate_(env->isolate) {
    const uint8_t* data = nullptr;
    size_t size = 0;
    if (!ReadArrayBufferViewBytes(buffer, &data, &size)) return;
    if (data != nullptr && size > 0) {
      data_.assign(data, data + size);
    }
    deserializer_ = std::make_unique<v8::ValueDeserializer>(
        isolate_, data_.empty() ? nullptr : data_.data(), data_.size(), this);

    wrap_.Reset(isolate_, wrap);
    wrap_.SetWeak(this, WeakCallback, v8::WeakCallbackType::kParameter);

    v8::Local<v8::Context> context = env_->context();
    v8::Context::Scope context_scope(context);
    (void)wrap->Set(context, OneByteString(isolate_, "buffer"), buffer);
}

DeserializerContext::~DeserializerContext() {
  wrap_.Reset();
  deserializer_.reset();
}

v8::MaybeLocal<v8::Object> DeserializerContext::ReadHostObject(v8::Isolate* isolate) {
    v8::Local<v8::Context> context = env_->context();
    v8::Local<v8::Object> wrap = wrap_.Get(isolate);

    v8::Local<v8::Value> hook;
    if (!wrap->Get(context, OneByteString(isolate, "_readHostObject")).ToLocal(&hook)) {
      return {};
    }
    if (!hook->IsFunction()) {
      return v8::ValueDeserializer::Delegate::ReadHostObject(isolate);
    }

    v8::Isolate::AllowJavascriptExecutionScope allow_js(isolate);
    v8::Local<v8::Value> ret;
    if (!hook.As<v8::Function>()->Call(context, wrap, 0, nullptr).ToLocal(&ret)) {
      return {};
    }
    if (!ret->IsObject()) {
      isolate->ThrowException(v8::Exception::TypeError(
          OneByteString(isolate, "readHostObject must return an object")));
      return {};
    }
    return ret.As<v8::Object>();
}

void DeserializerContext::New(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    if (!args.IsConstructCall()) {
      ThrowTypeErrorWithCode(args.GetIsolate()->GetCurrentContext(),
                             isolate,
                             "ERR_CONSTRUCT_CALL_REQUIRED",
                             "Class constructor Deserializer cannot be invoked without 'new'");
      return;
    }
    if (!args.Data()->IsExternal()) {
      isolate->ThrowException(v8::Exception::Error(
          OneByteString(isolate, "Internal deserializer constructor state missing")));
      return;
    }
    if (args.Length() < 1 || !args[0]->IsArrayBufferView()) {
      ThrowTypeErrorWithCode(args.GetIsolate()->GetCurrentContext(),
                             isolate,
                             "ERR_INVALID_ARG_TYPE",
                             "buffer must be a TypedArray or a DataView");
      return;
    }

    auto* env = static_cast<napi_env>(v8::Local<v8::External>::Cast(args.Data())->Value());
    if (env == nullptr) {
      isolate->ThrowException(v8::Exception::Error(
          OneByteString(isolate, "Internal deserializer environment missing")));
      return;
    }
    auto* ctx = env->allocate<DeserializerContext>(env, args.This(), args[0]);
    args.This()->SetAlignedPointerInInternalField(0, ctx);
}

void DeserializerContext::ReadHeader(const v8::FunctionCallbackInfo<v8::Value>& args) {
    DeserializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || !ctx->deserializer_) return;
    bool ok = false;
    if (ctx->deserializer_->ReadHeader(ctx->env_->context()).To(&ok)) {
      args.GetReturnValue().Set(ok);
    }
}

void DeserializerContext::ReadValue(const v8::FunctionCallbackInfo<v8::Value>& args) {
    DeserializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || !ctx->deserializer_) return;
    v8::Local<v8::Value> out;
    if (ctx->deserializer_->ReadValue(ctx->env_->context()).ToLocal(&out)) {
      args.GetReturnValue().Set(out);
    }
}

void DeserializerContext::TransferArrayBuffer(
    const v8::FunctionCallbackInfo<v8::Value>& args) {
    DeserializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || !ctx->deserializer_ || args.Length() < 2) return;
    uint32_t id = 0;
    if (!args[0]->Uint32Value(ctx->env_->context()).To(&id)) return;
    if (args[1]->IsArrayBuffer()) {
      ctx->deserializer_->TransferArrayBuffer(id, args[1].As<v8::ArrayBuffer>());
      return;
    }
    if (args[1]->IsSharedArrayBuffer()) {
      ctx->deserializer_->TransferSharedArrayBuffer(id, args[1].As<v8::SharedArrayBuffer>());
      return;
    }
    ThrowTypeErrorWithCode(ctx->env_->context(),
                           ctx->isolate_,
                           "ERR_INVALID_ARG_TYPE",
                           "arrayBuffer must be an ArrayBuffer or SharedArrayBuffer");
}

void DeserializerContext::GetWireFormatVersion(
    const v8::FunctionCallbackInfo<v8::Value>& args) {
    DeserializerContext* ctx = Unwrap(args);
    if (ctx == nullptr || !ctx->deserializer_) return;
    args.GetReturnValue().Set(v8::Integer::NewFromUnsigned(
        ctx->isolate_, ctx->deserializer_->GetWireFormatVersion()));
}

void DeserializerContext::ReadUint32(const v8::FunctionCallbackInfo<v8::Value>& args) {
  DeserializerContext* ctx = Unwrap(args);
  if (ctx == nullptr || !ctx->deserializer_) return;
  uint32_t value = 0;
  if (!ctx->deserializer_->ReadUint32(&value)) {
    ctx->isolate_->ThrowException(v8::Exception::Error(
        OneByteString(ctx->isolate_, "ReadUint32() failed")));
    return;
  }
  args.GetReturnValue().Set(v8::Integer::NewFromUnsigned(ctx->isolate_, value));
}

void DeserializerContext::ReadUint64(const v8::FunctionCallbackInfo<v8::Value>& args) {
  DeserializerContext* ctx = Unwrap(args);
  if (ctx == nullptr || !ctx->deserializer_) return;
  uint64_t value = 0;
  if (!ctx->deserializer_->ReadUint64(&value)) {
    ctx->isolate_->ThrowException(v8::Exception::Error(
        OneByteString(ctx->isolate_, "ReadUint64() failed")));
    return;
  }
  const uint32_t hi = static_cast<uint32_t>(value >> 32);
  const uint32_t lo = static_cast<uint32_t>(value);
  v8::Local<v8::Value> vals[2] = {
      v8::Integer::NewFromUnsigned(ctx->isolate_, hi),
      v8::Integer::NewFromUnsigned(ctx->isolate_, lo),
  };
  args.GetReturnValue().Set(v8::Array::New(ctx->isolate_, vals, 2));
}

void DeserializerContext::ReadDouble(const v8::FunctionCallbackInfo<v8::Value>& args) {
  DeserializerContext* ctx = Unwrap(args);
  if (ctx == nullptr || !ctx->deserializer_) return;
  double value = 0;
  if (!ctx->deserializer_->ReadDouble(&value)) {
    ctx->isolate_->ThrowException(v8::Exception::Error(
        OneByteString(ctx->isolate_, "ReadDouble() failed")));
    return;
  }
  args.GetReturnValue().Set(value);
}

void DeserializerContext::ReadRawBytes(const v8::FunctionCallbackInfo<v8::Value>& args) {
  DeserializerContext* ctx = Unwrap(args);
  if (ctx == nullptr || !ctx->deserializer_ || args.Length() < 1) return;

  int64_t requested = 0;
  if (!args[0]->IntegerValue(ctx->env_->context()).To(&requested) || requested < 0) {
    return;
  }
  const size_t length = static_cast<size_t>(requested);

  const void* read_ptr = nullptr;
  if (!ctx->deserializer_->ReadRawBytes(length, &read_ptr)) {
    ctx->isolate_->ThrowException(v8::Exception::Error(
        OneByteString(ctx->isolate_, "ReadRawBytes() failed")));
    return;
  }
  const uint8_t* pos = static_cast<const uint8_t*>(read_ptr);
  const uint8_t* base = ctx->data_.empty() ? nullptr : ctx->data_.data();
  if (base == nullptr || pos < base || pos + length > base + ctx->data_.size()) {
    ctx->isolate_->ThrowException(v8::Exception::Error(
        OneByteString(ctx->isolate_, "ReadRawBytes() returned out-of-range data")));
    return;
  }
  const uint32_t offset = static_cast<uint32_t>(pos - base);
  args.GetReturnValue().Set(v8::Integer::NewFromUnsigned(ctx->isolate_, offset));
}

DeserializerContext* DeserializerContext::Unwrap(
    const v8::FunctionCallbackInfo<v8::Value>& args) {
  if (args.This().IsEmpty() || args.This()->InternalFieldCount() < 1) return nullptr;
  return static_cast<DeserializerContext*>(args.This()->GetAlignedPointerFromInternalField(0));
}

void DeserializerContext::WeakCallback(
    const v8::WeakCallbackInfo<DeserializerContext>& info) {
  DeserializerContext* context = info.GetParameter();
  if (context != nullptr && context->env_ != nullptr) {
    context->env_->release(context);
  }
}

template <>
struct napi_lifetime_type_name__<SerializerContext> {
  static constexpr const char* value = "serializer_context";
};

template <>
struct napi_lifetime_type_name__<DeserializerContext> {
  static constexpr const char* value = "deserializer_context";
};
}  // namespace v8impl::detail

namespace {

using v8impl::detail::DeserializerContext;
using v8impl::detail::SerializerContext;

void SetProtoMethod(v8::Isolate* isolate,
                    v8::Local<v8::FunctionTemplate> tmpl,
                    const char* name,
                    v8::FunctionCallback callback) {
  tmpl->PrototypeTemplate()->Set(
      isolate,
      name,
      v8::FunctionTemplate::New(isolate, callback));
}

bool SetConstructorFunction(v8::Local<v8::Context> context,
                            v8::Local<v8::Object> target,
                            const char* name,
                            v8::Local<v8::FunctionTemplate> tmpl) {
  v8::Local<v8::Function> ctor;
  if (!tmpl->GetFunction(context).ToLocal(&ctor)) return false;
  return target->Set(context, OneByteString(context->GetIsolate(), name), ctor).FromMaybe(false);
}

class StructuredCloneSerializerDelegate final : public v8::ValueSerializer::Delegate {
 public:
  explicit StructuredCloneSerializerDelegate(v8::Isolate* isolate)
      : isolate_(isolate) {}

  void ThrowDataCloneError(v8::Local<v8::String> message) override {
    isolate_->ThrowException(v8::Exception::Error(message));
  }

  v8::Maybe<uint32_t> GetSharedArrayBufferId(
      v8::Isolate* /*isolate*/,
      v8::Local<v8::SharedArrayBuffer> shared_array_buffer) override {
    std::shared_ptr<v8::BackingStore> backing_store =
        shared_array_buffer->GetBackingStore();
    for (uint32_t i = 0; i < shared_array_buffers_.size(); ++i) {
      if (shared_array_buffers_[i] == backing_store) {
        return v8::Just(i);
      }
    }
    shared_array_buffers_.push_back(std::move(backing_store));
    return v8::Just(static_cast<uint32_t>(shared_array_buffers_.size() - 1));
  }

  v8::Maybe<uint32_t> GetWasmModuleTransferId(
      v8::Isolate* /*isolate*/,
      v8::Local<v8::WasmModuleObject> module) override {
    wasm_modules_.push_back(module->GetCompiledModule());
    return v8::Just(static_cast<uint32_t>(wasm_modules_.size() - 1));
  }

  const std::vector<std::shared_ptr<v8::BackingStore>>& shared_array_buffers() const {
    return shared_array_buffers_;
  }

  const std::vector<v8::CompiledWasmModule>& wasm_modules() const {
    return wasm_modules_;
  }

  std::vector<v8::CompiledWasmModule> TakeWasmModules() {
    return std::move(wasm_modules_);
  }

 private:
  v8::Isolate* isolate_ = nullptr;
  std::vector<std::shared_ptr<v8::BackingStore>> shared_array_buffers_;
  std::vector<v8::CompiledWasmModule> wasm_modules_;
};

class StructuredCloneDeserializerDelegate final : public v8::ValueDeserializer::Delegate {
 public:
  StructuredCloneDeserializerDelegate(
      v8::Isolate* isolate,
      const std::vector<std::shared_ptr<v8::BackingStore>>& shared_array_buffers,
      const std::vector<v8::CompiledWasmModule>& wasm_modules)
      : isolate_(isolate),
        shared_array_buffers_(shared_array_buffers),
        wasm_modules_(wasm_modules) {}

  v8::MaybeLocal<v8::SharedArrayBuffer> GetSharedArrayBufferFromId(
      v8::Isolate* isolate,
      uint32_t clone_id) override {
    if (clone_id >= shared_array_buffers_.size()) return {};
    return v8::SharedArrayBuffer::New(isolate, shared_array_buffers_[clone_id]);
  }

  v8::MaybeLocal<v8::WasmModuleObject> GetWasmModuleFromId(
      v8::Isolate* isolate,
      uint32_t transfer_id) override {
    if (transfer_id >= wasm_modules_.size()) return {};
    return v8::WasmModuleObject::FromCompiledModule(isolate, wasm_modules_[transfer_id]);
  }

 private:
  v8::Isolate* isolate_ = nullptr;
  const std::vector<std::shared_ptr<v8::BackingStore>>& shared_array_buffers_;
  const std::vector<v8::CompiledWasmModule>& wasm_modules_;
};

struct SerializedClonePayload {
  std::vector<uint8_t> bytes;
  std::vector<std::shared_ptr<v8::BackingStore>> array_buffers;
  std::vector<std::shared_ptr<v8::BackingStore>> shared_array_buffers;
  std::vector<v8::CompiledWasmModule> wasm_modules;
};

void ThrowCloneTransferError(v8::Isolate* isolate, const char* message) {
  v8::Local<v8::String> text =
      v8::String::NewFromUtf8(isolate, message, v8::NewStringType::kNormal)
          .ToLocalChecked();
  isolate->ThrowException(
      v8::Exception::Error(text));
}

napi_status CollectTransferArrayBuffers(
    napi_env env,
    v8::Local<v8::Context> context,
    v8::ValueSerializer* serializer,
    napi_value transfer_list,
    std::vector<v8::Local<v8::ArrayBuffer>>* out) {
  if (transfer_list == nullptr) return napi_ok;
  if (env == nullptr || serializer == nullptr || out == nullptr) return napi_invalid_arg;

  v8::Isolate* isolate = env->isolate;
  v8::Local<v8::Value> transfer_value = napi_v8_unwrap_value(transfer_list);
  if (!transfer_value->IsArray()) return napi_invalid_arg;

  v8::Local<v8::Array> array = transfer_value.As<v8::Array>();
  for (uint32_t i = 0; i < array->Length(); ++i) {
    v8::Local<v8::Value> entry;
    if (!array->Get(context, i).ToLocal(&entry)) {
      return napi_pending_exception;
    }
    if (!entry->IsArrayBuffer()) {
      ThrowCloneTransferError(isolate, "Only ArrayBuffer instances can be transferred");
      return napi_pending_exception;
    }
    v8::Local<v8::ArrayBuffer> array_buffer = entry.As<v8::ArrayBuffer>();
    if (!array_buffer->IsDetachable() || array_buffer->WasDetached()) {
      ThrowCloneTransferError(isolate, "An ArrayBuffer is detached and could not be cloned.");
      return napi_pending_exception;
    }
    if (std::find(out->begin(), out->end(), array_buffer) != out->end()) {
      ThrowCloneTransferError(isolate, "Transfer list contains duplicate ArrayBuffer");
      return napi_pending_exception;
    }
    serializer->TransferArrayBuffer(static_cast<uint32_t>(out->size()), array_buffer);
    out->push_back(array_buffer);
  }

  return napi_ok;
}

napi_status DetachTransferredArrayBuffers(
    const std::vector<v8::Local<v8::ArrayBuffer>>& array_buffers,
    std::vector<std::shared_ptr<v8::BackingStore>>* out) {
  if (out == nullptr) return napi_invalid_arg;
  out->clear();
  out->reserve(array_buffers.size());
  for (v8::Local<v8::ArrayBuffer> array_buffer : array_buffers) {
    std::shared_ptr<v8::BackingStore> backing_store = array_buffer->GetBackingStore();
    if (array_buffer->Detach(v8::Local<v8::Value>()).IsNothing()) {
      return napi_pending_exception;
    }
    out->push_back(std::move(backing_store));
  }
  return napi_ok;
}

napi_status DeserializeTransferredClone(
    napi_env env,
    const std::vector<uint8_t>& bytes,
    const std::vector<std::shared_ptr<v8::BackingStore>>& array_buffers,
    const std::vector<std::shared_ptr<v8::BackingStore>>& shared_array_buffers,
    const std::vector<v8::CompiledWasmModule>& wasm_modules,
    v8::Local<v8::Value>* result_out) {
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr) {
    return napi_invalid_arg;
  }

  v8::Isolate* isolate = env->isolate;
  v8::Local<v8::Context> context = env->context();
  StructuredCloneDeserializerDelegate deserializer_delegate(
      isolate, shared_array_buffers, wasm_modules);
  v8::ValueDeserializer deserializer(
      isolate,
      bytes.data(),
      bytes.size(),
      &deserializer_delegate);

  for (uint32_t i = 0; i < array_buffers.size(); ++i) {
    v8::Local<v8::ArrayBuffer> array_buffer =
        v8::ArrayBuffer::New(isolate, array_buffers[i]);
    deserializer.TransferArrayBuffer(i, array_buffer);
  }

  bool header_ok = false;
  if (!deserializer.ReadHeader(context).To(&header_ok) || !header_ok) {
    return isolate->IsExecutionTerminating() ? napi_pending_exception : napi_pending_exception;
  }

  v8::Local<v8::Value> output;
  if (!deserializer.ReadValue(context).ToLocal(&output)) {
    return isolate->IsExecutionTerminating() ? napi_pending_exception : napi_pending_exception;
  }

  *result_out = output;
  return result_out->IsEmpty() ? napi_generic_failure : napi_ok;
}

napi_status StructuredCloneImpl(
    napi_env env,
    napi_value value,
    napi_value transfer_list,
    napi_value* result_out) {
  if (env == nullptr || env->isolate == nullptr || value == nullptr || result_out == nullptr) {
    return napi_invalid_arg;
  }

  v8::Isolate* isolate = env->isolate;
  v8::EscapableHandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Value> input = napi_v8_unwrap_value(value);
  StructuredCloneSerializerDelegate serializer_delegate(isolate);
  v8::ValueSerializer serializer(isolate, &serializer_delegate);

  std::vector<v8::Local<v8::ArrayBuffer>> array_buffers;
  napi_status transfer_status =
      CollectTransferArrayBuffers(env, context, &serializer, transfer_list, &array_buffers);
  if (transfer_status != napi_ok) {
    return transfer_status;
  }

  serializer.WriteHeader();
  if (serializer.WriteValue(context, input).IsNothing()) {
    return isolate->IsExecutionTerminating() ? napi_pending_exception : napi_pending_exception;
  }

  std::vector<std::shared_ptr<v8::BackingStore>> transferred_array_buffers;
  transfer_status = DetachTransferredArrayBuffers(array_buffers, &transferred_array_buffers);
  if (transfer_status != napi_ok) {
    return transfer_status;
  }

  std::pair<uint8_t*, size_t> released = serializer.Release();
  if (released.first == nullptr) return napi_generic_failure;
  std::unique_ptr<uint8_t, decltype(&std::free)> buffer(released.first, &std::free);

  std::vector<uint8_t> bytes(buffer.get(), buffer.get() + released.second);
  v8::Local<v8::Value> output;
  napi_status deserialize_status = DeserializeTransferredClone(
      env,
      bytes,
      transferred_array_buffers,
      serializer_delegate.shared_array_buffers(),
      serializer_delegate.wasm_modules(),
      &output);
  if (deserialize_status != napi_ok) return deserialize_status;

  *result_out = napi_v8_wrap_value(env, handle_scope.Escape(output));
  return *result_out == nullptr ? napi_generic_failure : napi_ok;
}

}  // namespace

void NapiV8ApplyPromiseHooksToContext(napi_env env, v8::Local<v8::Context> context) {
  if (env == nullptr || env->isolate == nullptr || context.IsEmpty()) return;

#ifdef V8_ENABLE_JAVASCRIPT_PROMISE_HOOKS
  std::array<v8::Local<v8::Function>, 4> hooks =
      LookupPromiseHooksForContext(env, env->isolate);
  context->SetPromiseHooks(hooks[0], hooks[1], hooks[2], hooks[3]);
#else
  (void) env;
  (void) context;
#endif
}

extern "C" {

// iwci patch (#990): what confining V8's out-of-memory has cost the process
// so far (see `g_oom_mu`): isolates abandoned, threads parked, and how many
// of those were V8 worker threads. Host-only; never called by a guest.
void snapi_bridge_out_of_memory_losses(uint64_t* lost_isolates,
                                       uint64_t* parked_threads,
                                       uint64_t* parked_worker_threads) {
  std::lock_guard<std::mutex> lock(g_oom_mu);
  if (lost_isolates != nullptr) *lost_isolates = g_lost_isolates.size();
  if (parked_threads != nullptr) *parked_threads = g_parked_threads;
  if (parked_worker_threads != nullptr) *parked_worker_threads = g_parked_worker_threads;
}

napi_status NAPI_CDECL unofficial_napi_configure_runtime(
    const unofficial_napi_runtime_options* options) {
  if (options != nullptr &&
      (options->size < sizeof(unofficial_napi_runtime_options) ||
       options->version != UNOFFICIAL_NAPI_RUNTIME_OPTIONS_VERSION)) {
    return napi_invalid_arg;
  }
  return ConfigureRuntime(options != nullptr ? options->engine_flags : nullptr,
                          options != nullptr ? options->engine_flags_length : 0);
}

napi_status NAPI_CDECL unofficial_napi_create_guest_backed_typedarray(
    napi_env env, napi_typedarray_type type, size_t length, void** data,
    napi_value* result) {
  if (env == nullptr || data == nullptr || result == nullptr) return napi_invalid_arg;
  size_t element_size = 1;
  switch (type) {
    case napi_float16_array:
    case napi_int16_array:
    case napi_uint16_array: element_size = 2; break;
    case napi_int32_array:
    case napi_uint32_array:
    case napi_float32_array: element_size = 4; break;
    case napi_float64_array:
    case napi_bigint64_array:
    case napi_biguint64_array: element_size = 8; break;
    default: break;
  }
  if (length > SIZE_MAX / element_size) return napi_invalid_arg;
  napi_value arraybuffer;
  napi_status status = napi_create_arraybuffer(env, length * element_size, data, &arraybuffer);
  if (status != napi_ok) return status;
  return napi_create_typedarray(env, type, length, arraybuffer, 0, result);
}

napi_status NAPI_CDECL unofficial_napi_attach_env(
    napi_env env,
    const unofficial_napi_env_hooks* hooks,
    uint64_t* accepted_hooks_out) {
  if (env == nullptr || env->isolate == nullptr || hooks == nullptr ||
      accepted_hooks_out == nullptr ||
      hooks->size < sizeof(unofficial_napi_env_hooks) ||
      hooks->version != UNOFFICIAL_NAPI_ENV_HOOKS_VERSION ||
      env->embedder_hooks_attached) {
    return napi_invalid_arg;
  }
  {
    RuntimeLock lock;
    if (g_runtime.platform != nullptr &&
        !g_runtime.platform->BindForegroundTaskTarget(
            env->isolate,
            env,
            hooks->enqueue_foreground_task_callback,
            hooks->data)) {
      return napi_generic_failure;
    }
    auto& fatal = g_fatal_error_callbacks[env->isolate];
    fatal.fatal = hooks->fatal_error_callback;
    fatal.oom = hooks->oom_error_callback;
  }

  env->context_token_assign_callback = hooks->context_token_assign_callback;
  env->context_token_unassign_callback = hooks->context_token_unassign_callback;
  env->context_token_callback_data = hooks->data;
  env->enqueue_foreground_task_callback = hooks->enqueue_foreground_task_callback;
  env->enqueue_foreground_task_target = hooks->data;
  env->embedder_hooks_attached = true;

  env->isolate->SetFatalErrorHandler(
      hooks->fatal_error_callback != nullptr ? FatalErrorCallback : nullptr);
  // iwci patch (#972): always, so an out-of-memory can be confined.
  env->isolate->SetOOMErrorHandler(OOMErrorCallback);
  *accepted_hooks_out = unofficial_napi_env_hooks_requested(hooks);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_create_env_from_context(
    v8::Local<v8::Context> context, int32_t module_api_version, napi_env* result) {
  if (result == nullptr || context.IsEmpty()) return napi_invalid_arg;
  context->GetIsolate()->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  auto* env = new (std::nothrow) napi_env__(context, module_api_version);
  if (env == nullptr) return napi_generic_failure;
  {
    RuntimeLock lock;
    g_env_by_isolate[env->isolate] = env;
  }
  *result = env;
  return napi_ok;
}

static napi_status DestroyEnvInstance(napi_env env) {
  if (env == nullptr) return napi_invalid_arg;
  ProfilerState profiler_state;
  bool has_profiler_state = false;
  bool had_near_heap_limit_callback = false;
  {
    RuntimeLock lock;
    if (g_runtime.platform != nullptr) {
      g_runtime.platform->ClearForegroundTaskTarget(env->isolate, env);
    }
    auto env_it = g_env_by_isolate.find(env->isolate);
    if (env_it != g_env_by_isolate.end() && env_it->second == env) {
      g_env_by_isolate.erase(env_it);
    }
    g_hash_seeds.erase(env->isolate);
    auto cb_it = g_promise_reject_callbacks.find(env->isolate);
    if (cb_it != g_promise_reject_callbacks.end()) {
      cb_it->second.Reset();
      g_promise_reject_callbacks.erase(cb_it);
    }
    auto hooks_it = g_promise_hooks.find(env->isolate);
    if (hooks_it != g_promise_hooks.end()) {
      for (auto& hook : hooks_it->second) {
        hook.Reset();
      }
      g_promise_hooks.erase(hooks_it);
    }
    auto prepare_it = g_prepare_stack_trace_callbacks.find(env);
    if (prepare_it != g_prepare_stack_trace_callbacks.end()) {
      ResetPrepareStackTraceState(&prepare_it->second);
      g_prepare_stack_trace_callbacks.erase(prepare_it);
    }
    unofficial_napi_internal::ResetErrorFormattingState(env);
    g_fatal_error_callbacks.erase(env->isolate);
    had_near_heap_limit_callback =
        g_near_heap_limit_callbacks.erase(env->isolate) != 0;
    auto profiler_it = g_profiler_states.find(env);
    if (profiler_it != g_profiler_states.end()) {
      profiler_state = std::move(profiler_it->second);
      g_profiler_states.erase(profiler_it);
      has_profiler_state = true;
    }
  }
  if (env->isolate != nullptr) {
    if (has_profiler_state) {
      DisposeProfilerState(env, &profiler_state);
    }
    env->isolate->CancelTerminateExecution();
    env->isolate->SetPromiseHook(nullptr);
    env->isolate->SetPromiseRejectCallback(nullptr);
    env->isolate->SetFatalErrorHandler(nullptr);
    // iwci patch (#972): the isolate keeps OOMErrorCallback until disposed.
    // iwci patch (#1021): and gets room for its teardown. Disposing it ends
    // an incremental marking with a full collection
    // (`CppHeap::StartDetachingIsolate`), which reaches V8's heap limit when
    // the budget stopped the isolate there: that ran out of memory in an
    // isolate being disposed, where it cannot be confined, and aborted the
    // runner. The budget's callback goes first: its data is this env, about
    // to be freed.
    if (had_near_heap_limit_callback) {
      env->isolate->RemoveNearHeapLimitCallback(NearHeapLimitCallback, 0);
      // iwci patch (#1063): installed with it, with this env, freed below.
      env->isolate->RemoveGCEpilogueCallback(HeapCommittedCallback, env);
    }
    v8::HeapStatistics heap;
    env->isolate->GetHeapStatistics(&heap);
    env->isolate->AddNearHeapLimitCallback(
        TeardownNearHeapLimitCallback,
        reinterpret_cast<void*>(static_cast<uintptr_t>(
            heap.heap_size_limit() + kTeardownHeapSlackMax)));
  }
  delete env;
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_configure_near_heap_limit_callback(
    napi_env env,
    unofficial_napi_near_heap_limit_callback callback_or_null,
    void* data,
    size_t restored_heap_limit) {
  if (env == nullptr || env->isolate == nullptr ||
      (callback_or_null != nullptr && restored_heap_limit != 0) ||
      (callback_or_null == nullptr && data != nullptr)) {
    return napi_invalid_arg;
  }

  if (callback_or_null != nullptr) {
    bool install_provider_callback = false;
    {
      RuntimeLock lock;
      auto [it, inserted] =
          g_near_heap_limit_callbacks.try_emplace(env->isolate);
      it->second.callback = callback_or_null;
      it->second.data = data;
      install_provider_callback = inserted;
    }
    // iwci patch (#972): only the host installs one (the guest's import is a
    // no-op), with its budget tracker as `data`.
    {
      std::lock_guard<std::mutex> lock(g_oom_mu);
      g_oom_host_data[env->isolate] = data;
    }
    if (install_provider_callback) {
      env->isolate->AddNearHeapLimitCallback(NearHeapLimitCallback, env);
      // iwci patch (#1063): and the heap it has committed, after every
      // collection.
      env->isolate->AddGCEpilogueCallback(HeapCommittedCallback, env);
    }
    return napi_ok;
  }

  bool remove_provider_callback = false;
  {
    RuntimeLock lock;
    remove_provider_callback =
        g_near_heap_limit_callbacks.erase(env->isolate) != 0;
  }
  {
    std::lock_guard<std::mutex> lock(g_oom_mu);
    g_oom_host_data.erase(env->isolate);
  }
  if (remove_provider_callback) {
    env->isolate->RemoveNearHeapLimitCallback(
        NearHeapLimitCallback, restored_heap_limit);
    env->isolate->RemoveGCEpilogueCallback(HeapCommittedCallback, env);
  }
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_wrap_existing_value(napi_env env,
                                                           v8::Local<v8::Value> value,
                                                           napi_value* result) {
  if (env == nullptr || value.IsEmpty() || result == nullptr) return napi_invalid_arg;
  *result = napi_v8_wrap_value(env, value);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_create_env(
    int32_t module_api_version,
    const unofficial_napi_env_create_options* options,
    napi_env* env_out,
    unofficial_napi_env_owner* owner_out) {
  if (options != nullptr &&
      (options->size < sizeof(unofficial_napi_env_create_options) ||
       options->version != UNOFFICIAL_NAPI_ENV_CREATE_OPTIONS_VERSION)) {
    // The descriptor is not large enough to transfer guest_heap ownership.
    return napi_invalid_arg;
  }

  // Size/version validation above proves that guest_heap is present. This
  // function owns it from here on and must release it exactly once.
  unofficial_napi_guest_heap guest_heap =
      options != nullptr ? options->guest_heap : nullptr;
  if (env_out == nullptr || owner_out == nullptr) {
    if (guest_heap != nullptr) napi_host_guest_heap_release(guest_heap);
    return napi_invalid_arg;
  }
  EdgeV8Platform* platform = nullptr;
  napi_status status = AcquireRuntime(&platform);
  if (status != napi_ok || platform == nullptr) {
    if (guest_heap != nullptr) napi_host_guest_heap_release(guest_heap);
    return status != napi_ok ? status : napi_generic_failure;
  }

  auto allocator = std::make_shared<TrackingArrayBufferAllocator>();
  if (!allocator) {
    if (guest_heap != nullptr) napi_host_guest_heap_release(guest_heap);
    ReleaseRuntime();
    return napi_generic_failure;
  }
  if (guest_heap != nullptr) {
    // Armed before the isolate exists, so even bootstrap-time backing stores
    // are guest-memory-backed. The allocator's destructor releases the ctx on
    // every later failure path.
    allocator->set_guest_heap(guest_heap);
  }

  v8::Isolate::CreateParams params{};
  params.array_buffer_allocator_shared = allocator;
  if (options != nullptr) {
    if (options->max_young_generation_size_in_bytes > 0) {
      params.constraints.set_max_young_generation_size_in_bytes(
          options->max_young_generation_size_in_bytes);
    }
    if (options->max_old_generation_size_in_bytes > 0) {
      params.constraints.set_max_old_generation_size_in_bytes(
          options->max_old_generation_size_in_bytes);
    }
    if (options->code_range_size_in_bytes > 0) {
      params.constraints.set_code_range_size_in_bytes(
          options->code_range_size_in_bytes);
    }
    if (options->stack_limit != nullptr) {
      params.constraints.set_stack_limit(
          static_cast<uint32_t*>(options->stack_limit));
    }
  }
  ApplyNodeIsolateCreateParams(&params, options);
  v8::Isolate* isolate = CreateIsolateForEnv(platform, params);
  if (isolate == nullptr) {
    ReleaseRuntime();
    return napi_generic_failure;
  }
  {
    RuntimeLock lock;
    g_hash_seeds[isolate] = GenerateHashSeed();
    g_tracking_allocators[allocator.get()] = allocator;
  }

  auto* scope = new (std::nothrow) UnofficialEnvScope(isolate, allocator);
  if (scope == nullptr) {
    DisposeIsolateAndWait(platform, isolate);
    {
      RuntimeLock lock;
      g_tracking_allocators.erase(allocator.get());
    }
    ReleaseRuntime();
    return napi_generic_failure;
  }

  v8::Local<v8::Context> context = v8::Context::New(isolate);
  scope->context.emplace(isolate, context);
  scope->context_scope.emplace(context);
  status = unofficial_napi_create_env_from_context(context, module_api_version, &scope->env);
  if (status != napi_ok || scope->env == nullptr) {
    delete scope;
    DisposeIsolateAndWait(platform, isolate);
    {
      RuntimeLock lock;
      g_tracking_allocators.erase(allocator.get());
    }
    ReleaseRuntime();
    return (status == napi_ok) ? napi_generic_failure : status;
  }

  *env_out = scope->env;
  *owner_out = reinterpret_cast<unofficial_napi_env_owner>(scope);
  return napi_ok;
}

napi_status ReleaseEnvScope(unofficial_napi_env_owner owner,
                            void* shutdown_pump_handle) {
  if (owner == nullptr) return napi_invalid_arg;
  auto* scope = reinterpret_cast<UnofficialEnvScope*>(owner);

  // iwci patch (#972): an isolate a parked thread abandoned is never torn
  // down. That thread holds a running local heap, so the next garbage
  // collection, a finalizer's included, would wait for it forever, and
  // Dispose would join its task forever, holding the lock every isolate
  // creation takes. Its env and heap are leaked; only the scopes this thread
  // entered are left. Otherwise it is marked as being disposed first, so a
  // thread that runs out of memory for it from now on aborts rather than
  // parks (see `g_disposing_isolates`).
  bool lost = false;
  {
    std::lock_guard<std::mutex> lock(g_oom_mu);
    lost = g_lost_isolates.count(scope->isolate) != 0;
  }

  napi_status status = napi_ok;
  if (scope->env != nullptr && !lost) {
    status = DestroyEnvInstance(scope->env);
  } else if (lost) {
    // iwci patch (#1021): the host frees the budget's data once this
    // returns, so its callback must not be reached from here on.
    RuntimeLock lock;
    g_near_heap_limit_callbacks.erase(scope->isolate);
  }
  scope->env = nullptr;

  v8::Isolate* isolate = scope->isolate;
  std::shared_ptr<TrackingArrayBufferAllocator> allocator = scope->allocator;
  delete scope;

  if (isolate != nullptr) {
    {
      std::lock_guard<std::mutex> lock(g_oom_mu);
      lost = g_lost_isolates.count(isolate) != 0;
      if (!lost) g_disposing_isolates.insert(isolate);
    }
    if (!lost) {
      EdgeV8Platform* platform = nullptr;
      {
        RuntimeLock lock;
        platform = g_runtime.platform.get();
      }
      DisposeIsolateAndWait(platform, isolate, shutdown_pump_handle);
    }
    std::lock_guard<std::mutex> lock(g_oom_mu);
    g_disposing_isolates.erase(isolate);
    g_oom_host_data.erase(isolate);
  }
  if (allocator != nullptr) {
    {
      RuntimeLock lock;
      g_tracking_allocators.erase(allocator.get());
    }
  }
  ReleaseRuntime();
  return status;
}

napi_status NAPI_CDECL unofficial_napi_release_env(unofficial_napi_env_owner owner,
                                                   struct uv_loop_s* loop) {
  return ReleaseEnvScope(owner, static_cast<void*>(loop));
}

napi_status NAPI_CDECL unofficial_napi_collect_garbage(napi_env env) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
  // This is the production embedder API for asking V8 to reclaim as much
  // memory as possible. RequestGarbageCollectionForTesting is intentionally
  // not used: it aborts unless V8 was initialized with testing-only flags.
  env->isolate->LowMemoryNotification();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_set_prepare_stack_trace_callback(
    napi_env env,
    napi_value callback) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;

  v8::Local<v8::Value> raw = callback != nullptr ? napi_v8_unwrap_value(callback) : v8::Local<v8::Value>();
  if (!raw.IsEmpty() && !raw->IsFunction()) return napi_invalid_arg;
  v8::Local<v8::Context> current_context = env->isolate->GetCurrentContext();
  if (current_context.IsEmpty()) {
    current_context = env->context();
  }

  bool has_prepare_stack_trace_callback = false;
  {
    RuntimeLock lock;
    PrepareStackTraceState& state = g_prepare_stack_trace_callbacks[env];
    v8::Local<v8::Context> principal_context = env->context();
    const bool use_principal_callback =
        current_context.IsEmpty() ||
        (!principal_context.IsEmpty() &&
         (current_context == principal_context ||
          NapiV8IsContextifyContext(env, current_context)));

    if (use_principal_callback) {
      state.principal_callback.Reset();
      if (!raw.IsEmpty()) {
        state.principal_callback.Reset(env->isolate, raw.As<v8::Function>());
      }
    } else {
      for (auto it = state.context_callbacks.begin(); it != state.context_callbacks.end(); ++it) {
        v8::Local<v8::Context> candidate = it->context.Get(env->isolate);
        if (!candidate.IsEmpty() && candidate == current_context) {
          it->context.Reset();
          it->callback.Reset();
          state.context_callbacks.erase(it);
          break;
        }
      }
      if (!raw.IsEmpty()) {
        PrepareStackTraceContextCallback entry;
        entry.context.Reset(env->isolate, current_context);
        entry.callback.Reset(env->isolate, raw.As<v8::Function>());
        state.context_callbacks.push_back(std::move(entry));
      }
    }

    if (state.principal_callback.IsEmpty() && state.context_callbacks.empty()) {
      g_prepare_stack_trace_callbacks.erase(env);
    } else {
      has_prepare_stack_trace_callback = true;
    }
  }

  env->isolate->SetPrepareStackTraceCallback(
      has_prepare_stack_trace_callback ? NapiPrepareStackTraceCallback : nullptr);
  return napi_ok;
}

// V8 posts some of its own deferred foreground work (most notably
// Heap::PostFinalizationRegistryCleanupTaskIfNeeded's cleanup task, run after
// GC finds a JSFinalizationRegistry with dead targets) via
// v8::TaskRunner::PostNonNestableTask on the runner EdgeV8Platform hands back
// for the isolate. That runner forwards to the guest's own enqueue callback
// when one is bound (see EdgeV8Platform::BindForegroundTaskTarget), but the
// guest is not required to bind one -- it may drive everything through
// the provider-owned event-loop checkpoint instead. Tasks posted with no guest
// target bound fall back to the stock default-platform runner, and nothing
// else ever pumps that runner's queue, so without this they are posted and
// then never run: V8 correctly collects the dead targets, but their
// FinalizationRegistry callbacks never fire. Pump it here, at the same point
// microtasks are already checkpointed, so this deferred work always gets a
// chance to run regardless of whether the guest wired up its own hook.
bool PumpPlatformForegroundTasks(napi_env env) {
  if (env == nullptr || env->isolate == nullptr) return false;
  EdgeV8Platform* platform = nullptr;
  {
    RuntimeLock lock;
    platform = g_runtime.platform.get();
  }
  return platform != nullptr &&
         platform->PumpPendingForegroundTasks(env->isolate);
}

// iwci patch (#943): microtasks, then the platform's foreground tasks, and
// again while those ran, a few rounds at most. A task can settle a promise
// (the end of a WebAssembly.compile does), and its reactions were otherwise
// left queued after the one checkpoint, where nothing ran them until
// something else woke the loop. Returns whether the last round still ran a
// task, so the caller can ask for another turn rather than loop here;
// `ran_any` says whether any round did.
bool DrainMicrotasksForEnv(napi_env env, bool* ran_any = nullptr) {
  if (env == nullptr || env->isolate == nullptr) return false;
  env->DrainFinalizerQueue();
  for (int round = 0; round < 4; ++round) {
    v8::HandleScope scope(env->isolate);
    v8::Local<v8::Context> context = env->context();
    v8::MicrotaskQueue* queue =
        context.IsEmpty() ? nullptr : context->GetMicrotaskQueue();
    if (queue != nullptr) {
      queue->PerformCheckpoint(env->isolate);
    } else {
      env->isolate->PerformMicrotaskCheckpoint();
    }
    env->DrainFinalizerQueue();
    if (!PumpPlatformForegroundTasks(env)) return false;
    if (ran_any != nullptr) *ran_any = true;
  }
  return true;
}

// iwci patch (#943): how long a host task turn may wait for the platform's
// work. With nothing runnable in the loop (it has only timers or I/O that are
// not due yet, or it is empty) the turn waits up to kPlatformWaitLimit;
// libuv's own events are looked at again after it. When the loop has
// something runnable, the first turn does not wait at all, and only a run of
// such turns in which none of the platform's tasks came (a loop with nothing
// left in it, whose runnable flag is always set) backs off up to the same
// limit, so it does not spin.
constexpr std::chrono::microseconds kPlatformWaitLimit{1000};
constexpr std::chrono::microseconds kPlatformBackoffStart{25};

struct PlatformWaitStreak {
  napi_env env = nullptr;
  int turns = 0;
};
thread_local PlatformWaitStreak t_platform_wait_streak;

// iwci patch (#943): admit a host task turn for the platform's work. The
// bridge binds no foreground task target for a guest (the guest's enqueue
// hook would have to run guest code on V8's threads), so a task V8 posts for
// the isolate from another thread, such as the end of a WebAssembly.compile,
// waits in the platform's queue for a checkpoint, and nothing here can wake
// the guest's libuv. So while the isolate has background work in flight (or
// such a task is waiting), the checkpoint waits for it instead, woken the
// moment the task is posted or the work ends, and reports the work pending
// and the turn admitted: the runtime neither sleeps in libuv past the task
// nor treats its loop as empty, which is Node's DrainTasks.
bool AdmitPlatformWork(napi_env env, bool has_runnable_work) {
  PlatformWaitStreak& streak = t_platform_wait_streak;
  if (streak.env != env) streak = PlatformWaitStreak{env, 0};
  EdgeV8Platform* platform = nullptr;
  {
    RuntimeLock lock;
    platform = g_runtime.platform.get();
  }
  if (platform == nullptr || !platform->HasPendingWork(env->isolate)) {
    streak.turns = 0;
    return false;
  }
  std::chrono::microseconds wait{0};
  if (!has_runnable_work) {
    wait = kPlatformWaitLimit;
  } else if (streak.turns > 0) {
    wait = std::min(kPlatformWaitLimit,
                    kPlatformBackoffStart * (1 << std::min(streak.turns - 1, 6)));
  }
  if (wait.count() > 0) platform->WaitForPendingWork(env->isolate, wait);
  bool ran = false;
  (void)DrainMicrotasksForEnv(env, &ran);
  streak.turns = has_runnable_work && !ran ? streak.turns + 1 : 0;
  return true;
}

napi_status NAPI_CDECL unofficial_napi_event_loop_checkpoint(
    napi_env env,
    unofficial_napi_event_loop_checkpoint_mode mode,
    bool has_runnable_work,
    uint32_t* state_out) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
  if (mode != unofficial_napi_event_loop_checkpoint_microtasks &&
      mode != unofficial_napi_event_loop_checkpoint_host_tasks) {
    return napi_invalid_arg;
  }
  const bool tasks_left = DrainMicrotasksForEnv(env);
  // iwci patch (#943): only a host task turn may wait or keep the loop going.
  const bool platform_work =
      mode == unofficial_napi_event_loop_checkpoint_host_tasks &&
      (AdmitPlatformWork(env, has_runnable_work) || tasks_left);
  if (state_out != nullptr) {
    uint32_t state = unofficial_napi_event_loop_checkpoint_state_none;
    if (NapiV8HasPendingProviderWork(env)) {
      state |= unofficial_napi_event_loop_checkpoint_state_pending_provider_work;
    }
    if (platform_work) {
      state |= unofficial_napi_event_loop_checkpoint_state_pending_provider_work |
               unofficial_napi_event_loop_checkpoint_state_host_tasks_admitted;
    }
    *state_out = state;
  }
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_create_uninitialized_arraybuffer(
    napi_env env,
    size_t length,
    bool zero_fill,
    napi_value* result) {
  if (env == nullptr || env->isolate == nullptr || result == nullptr) {
    return napi_invalid_arg;
  }
  if (length == 0) {
    return napi_create_arraybuffer(env, 0, nullptr, result);
  }

  void* data = zero_fill ? std::calloc(length, 1) : std::malloc(length);
  if (data == nullptr) return napi_generic_failure;
  napi_status status = napi_create_external_arraybuffer(
      env,
      data,
      length,
      [](napi_env, void* bytes, void*) { std::free(bytes); },
      nullptr,
      result);
  if (status != napi_ok) std::free(data);
  return status;
}

napi_status NAPI_CDECL unofficial_napi_terminate_execution(napi_env env) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
  env->isolate->TerminateExecution();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_cancel_terminate_execution(napi_env env) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
  env->isolate->CancelTerminateExecution();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_request_interrupt(
    napi_env env,
    unofficial_napi_interrupt_callback callback,
    void* data) {
  if (env == nullptr || env->isolate == nullptr || callback == nullptr) {
    return napi_invalid_arg;
  }

  auto* request = new (std::nothrow) InterruptRequest();
  if (request == nullptr) return napi_generic_failure;
  request->env = env;
  request->callback = callback;
  request->data = data;

  env->isolate->RequestInterrupt(
      [](v8::Isolate* isolate, void* raw) {
        std::unique_ptr<InterruptRequest> request(
            static_cast<InterruptRequest*>(raw));
        if (request == nullptr || request->env == nullptr ||
            request->callback == nullptr ||
            request->env->isolate != isolate) {
          return;
        }
        v8::HandleScope handle_scope(isolate);
        v8::Local<v8::Context> context = request->env->context();
        if (context.IsEmpty()) return;
        v8::Context::Scope context_scope(context);
        request->callback(request->env, request->data);
      },
      request);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_structured_clone(
    napi_env env,
    napi_value value,
    napi_value transfer_list_or_null,
    napi_value* result_out) {
  return StructuredCloneImpl(env, value, transfer_list_or_null, result_out);
}

napi_status NAPI_CDECL unofficial_napi_message_create(
    napi_env env,
    napi_value value,
    unofficial_napi_message* message_out) {
  if (env == nullptr || env->isolate == nullptr || value == nullptr || message_out == nullptr) {
    return napi_invalid_arg;
  }
  *message_out = nullptr;

  v8::Isolate* isolate = env->isolate;
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Value> input = napi_v8_unwrap_value(value);
  StructuredCloneSerializerDelegate serializer_delegate(isolate);
  v8::ValueSerializer serializer(isolate, &serializer_delegate);

  serializer.WriteHeader();
  if (serializer.WriteValue(context, input).IsNothing()) {
    return napi_pending_exception;
  }

  std::pair<uint8_t*, size_t> released = serializer.Release();
  if (released.first == nullptr) return napi_generic_failure;

  auto* payload = new (std::nothrow) SerializedClonePayload();
  if (payload == nullptr) {
    std::free(released.first);
    return napi_generic_failure;
  }
  payload->bytes.assign(released.first, released.first + released.second);
  std::free(released.first);
  payload->shared_array_buffers = serializer_delegate.shared_array_buffers();
  payload->wasm_modules = serializer_delegate.TakeWasmModules();
  *message_out = reinterpret_cast<unofficial_napi_message>(payload);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_message_take(
    napi_env env,
    unofficial_napi_message message,
    napi_value* result_out) {
  if (message == nullptr) return napi_invalid_arg;
  std::unique_ptr<SerializedClonePayload> payload(
      reinterpret_cast<SerializedClonePayload*>(message));
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr) {
    return napi_invalid_arg;
  }
  *result_out = nullptr;

  v8::Isolate* isolate = env->isolate;
  v8::EscapableHandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Value> output;
  napi_status deserialize_status = DeserializeTransferredClone(
      env,
      payload->bytes,
      payload->array_buffers,
      payload->shared_array_buffers,
      payload->wasm_modules,
      &output);
  if (deserialize_status != napi_ok) return deserialize_status;

  *result_out = napi_v8_wrap_value(env, handle_scope.Escape(output));
  return *result_out == nullptr ? napi_generic_failure : napi_ok;
}

void NAPI_CDECL unofficial_napi_message_drop(unofficial_napi_message message) {
  delete reinterpret_cast<SerializedClonePayload*>(message);
}

napi_status NAPI_CDECL unofficial_napi_enqueue_microtask(napi_env env, napi_value callback) {
  if (env == nullptr || env->isolate == nullptr || callback == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(callback);
  if (!raw->IsFunction()) return napi_function_expected;
  env->context()->GetMicrotaskQueue()->EnqueueMicrotask(env->isolate, raw.As<v8::Function>());
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_set_promise_reject_callback(napi_env env,
                                                                   napi_value callback) {
  if (env == nullptr || env->isolate == nullptr || callback == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(callback);
  if (!raw->IsFunction()) return napi_function_expected;
  {
    RuntimeLock lock;
    g_env_by_isolate[env->isolate] = env;
    auto& slot = g_promise_reject_callbacks[env->isolate];
    slot.Reset();
    slot.Reset(env->isolate, raw.As<v8::Function>());
  }
  env->isolate->SetPromiseRejectCallback(PromiseRejectCallback);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_set_promise_hooks(napi_env env,
                                                         napi_value init,
                                                         napi_value before,
                                                         napi_value after,
                                                         napi_value resolve) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;

  std::array<v8::Local<v8::Function>, 4> hooks;
  if (!GetPromiseHookFunction(env, init, &hooks[0]) ||
      !GetPromiseHookFunction(env, before, &hooks[1]) ||
      !GetPromiseHookFunction(env, after, &hooks[2]) ||
      !GetPromiseHookFunction(env, resolve, &hooks[3])) {
    return napi_function_expected;
  }

  std::array<v8::Global<v8::Function>, 4> persistent_hooks;
  for (size_t i = 0; i < hooks.size(); ++i) {
    if (!hooks[i].IsEmpty()) {
      persistent_hooks[i].Reset(env->isolate, hooks[i]);
    }
  }
  const bool has_hooks = HasPromiseHooks(persistent_hooks);

  {
    RuntimeLock lock;
    g_env_by_isolate[env->isolate] = env;

    auto existing = g_promise_hooks.find(env->isolate);
    if (existing != g_promise_hooks.end()) {
      for (auto& hook : existing->second) {
        hook.Reset();
      }
    }

    if (has_hooks) {
      g_promise_hooks[env->isolate] = std::move(persistent_hooks);
    } else if (existing != g_promise_hooks.end()) {
      g_promise_hooks.erase(existing);
    }
  }

#ifdef V8_ENABLE_JAVASCRIPT_PROMISE_HOOKS
  NapiV8ApplyPromiseHooksToContext(env, env->context());
  NapiV8ApplyPromiseHooksToContextifyContexts(env);
#else
  env->isolate->SetPromiseHook(has_hooks ? PromiseHookCallback : nullptr);
#endif
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_promise_details(napi_env env,
                                                           napi_value promise,
                                                           int32_t* state_out,
                                                           napi_value* result_out,
                                                           bool* has_result_out) {
  if (env == nullptr || promise == nullptr || state_out == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(promise);
  if (raw.IsEmpty() || !raw->IsPromise()) return napi_invalid_arg;

  v8::Local<v8::Promise> p = raw.As<v8::Promise>();
  const v8::Promise::PromiseState state = p->State();
  *state_out = static_cast<int32_t>(state);

  const bool has_result = state != v8::Promise::PromiseState::kPending;
  if (has_result_out != nullptr) *has_result_out = has_result;

  if (result_out != nullptr) {
    *result_out = nullptr;
    if (has_result) {
      *result_out = napi_v8_wrap_value(env, p->Result());
      if (*result_out == nullptr) return napi_generic_failure;
    }
  }

  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_error_metadata(
    napi_env env,
    napi_value error,
    unofficial_napi_error_metadata_mode mode,
    unofficial_napi_error_metadata* out) {
  return unofficial_napi_internal::GetErrorMetadata(env, error, mode, out);
}

napi_status NAPI_CDECL unofficial_napi_configure_source_maps(
    napi_env env,
    bool enabled,
    napi_value callback) {
  return unofficial_napi_internal::ConfigureSourceMaps(env, enabled, callback);
}

napi_status NAPI_CDECL unofficial_napi_preserve_error_source_message(
    napi_env env,
    napi_value error) {
  return unofficial_napi_internal::PreserveErrorSourceMessage(env, error);
}

napi_status NAPI_CDECL unofficial_napi_mark_promise_as_handled(
    napi_env env,
    napi_value promise) {
  if (env == nullptr || promise == nullptr) return napi_invalid_arg;

  v8::Local<v8::Value> raw = napi_v8_unwrap_value(promise);
  if (raw.IsEmpty() || !raw->IsPromise()) return napi_invalid_arg;

  v8::Isolate* isolate = env->isolate;
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);
  v8::Local<v8::Promise> local_promise = raw.As<v8::Promise>();
  if (local_promise->State() != v8::Promise::PromiseState::kRejected) {
    return napi_ok;
  }

  v8::Local<v8::Function> callback;
  {
    RuntimeLock lock;
    const auto cb_it = g_promise_reject_callbacks.find(isolate);
    if (cb_it == g_promise_reject_callbacks.end() || cb_it->second.IsEmpty()) {
      return napi_ok;
    }
    callback = cb_it->second.Get(isolate);
  }
  if (callback.IsEmpty()) return napi_ok;

  v8::Local<v8::Value> args[3] = {
      v8::Integer::New(
          isolate,
          static_cast<int32_t>(v8::PromiseRejectEvent::kPromiseHandlerAddedAfterReject)),
      local_promise,
      v8::Undefined(isolate),
  };
  v8::TryCatch try_catch(isolate);
  v8::MaybeLocal<v8::Value> maybe_result =
      callback->Call(context, v8::Undefined(isolate), 3, args);
  if (maybe_result.IsEmpty()) {
    if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
      try_catch.ReThrow();
      return napi_pending_exception;
    }
    return napi_generic_failure;
  }
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_proxy_details(napi_env env,
                                                         napi_value proxy,
                                                         napi_value* target_out,
                                                         napi_value* handler_out) {
  if (env == nullptr || proxy == nullptr || target_out == nullptr || handler_out == nullptr) {
    return napi_invalid_arg;
  }

  v8::Local<v8::Value> raw = napi_v8_unwrap_value(proxy);
  if (raw.IsEmpty() || !raw->IsProxy()) return napi_invalid_arg;

  v8::Local<v8::Proxy> p = raw.As<v8::Proxy>();
  *target_out = napi_v8_wrap_value(env, p->GetTarget());
  *handler_out = napi_v8_wrap_value(env, p->GetHandler());
  if (*target_out == nullptr || *handler_out == nullptr) return napi_generic_failure;
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_preview_entries(napi_env env,
                                                       napi_value value,
                                                       napi_value* entries_out,
                                                       bool* is_key_value_out) {
  if (env == nullptr || value == nullptr || entries_out == nullptr || is_key_value_out == nullptr) {
    return napi_invalid_arg;
  }

  v8::Local<v8::Value> raw = napi_v8_unwrap_value(value);
  if (raw.IsEmpty() || !raw->IsObject()) return napi_invalid_arg;

  bool is_key_value = false;
  v8::Local<v8::Array> entries;
  if (!raw.As<v8::Object>()->PreviewEntries(&is_key_value).ToLocal(&entries)) {
    return napi_generic_failure;
  }
  *entries_out = napi_v8_wrap_value(env, entries);
  if (*entries_out == nullptr) return napi_generic_failure;
  *is_key_value_out = is_key_value;
  return napi_ok;
}

namespace {

napi_status GetCallSitesImpl(napi_env env,
                             uint32_t frames,
                             uint32_t skip_frames,
                             napi_value* callsites_out) {
  if (env == nullptr || env->isolate == nullptr || callsites_out == nullptr) return napi_invalid_arg;
  if (frames < 1 || frames > 200) return napi_invalid_arg;

  v8::Isolate* isolate = env->isolate;
  v8::EscapableHandleScope scope(isolate);
  v8::Local<v8::Context> context = env->context();

  v8::Local<v8::StackTrace> stack = v8::StackTrace::CurrentStackTrace(isolate, frames + skip_frames);
  const int frame_count = stack->GetFrameCount();
  const int start_index = frame_count > 0 ? static_cast<int>(skip_frames) : 0;
  const int available = frame_count - start_index;
  uint32_t count = available > 0 ? static_cast<uint32_t>(available) : 0;
  if (count > frames) count = frames;
  v8::Local<v8::Array> out = v8::Array::New(isolate, count);

  auto set_named = [&](v8::Local<v8::Object> obj, const char* key, v8::Local<v8::Value> value) -> bool {
    v8::Local<v8::String> k;
    if (!v8::String::NewFromUtf8(isolate, key, v8::NewStringType::kNormal).ToLocal(&k)) return false;
    return obj->Set(context, k, value).FromMaybe(false);
  };

  for (uint32_t out_index = 0; out_index < count; ++out_index) {
    const int i = start_index + static_cast<int>(out_index);
    v8::Local<v8::StackFrame> frame = stack->GetFrame(isolate, i);
    v8::Local<v8::Object> callsite = v8::Object::New(isolate);
    if (callsite->SetPrototype(context, v8::Null(isolate)).IsNothing()) return napi_generic_failure;

    v8::Local<v8::Value> function_name = frame->GetFunctionName();
    if (function_name.IsEmpty()) function_name = v8::String::Empty(isolate);

    v8::Local<v8::Value> script_name = frame->GetScriptName();
    if (script_name.IsEmpty()) script_name = v8::String::Empty(isolate);
    const std::string script_id = std::to_string(frame->GetScriptId());
    v8::Local<v8::String> script_id_v8;
    if (!v8::String::NewFromUtf8(isolate,
                                 script_id.data(),
                                 v8::NewStringType::kNormal,
                                 static_cast<int>(script_id.size()))
             .ToLocal(&script_id_v8)) {
      return napi_generic_failure;
    }

    const uint32_t line = frame->GetLineNumber();
    const uint32_t col = frame->GetColumn();
    if (!set_named(callsite, "functionName", function_name) ||
        !set_named(callsite, "scriptId", script_id_v8) ||
        !set_named(callsite, "scriptName", script_name) ||
        !set_named(callsite, "lineNumber", v8::Integer::NewFromUnsigned(isolate, line)) ||
        !set_named(callsite, "columnNumber", v8::Integer::NewFromUnsigned(isolate, col)) ||
        !set_named(callsite, "column", v8::Integer::NewFromUnsigned(isolate, col)) ||
        out->Set(context, out_index, callsite).IsNothing()) {
      return napi_generic_failure;
    }
  }

  *callsites_out = napi_v8_wrap_value(env, scope.Escape(out));
  if (*callsites_out == nullptr) return napi_generic_failure;
  return napi_ok;
}

}  // namespace

napi_status NAPI_CDECL unofficial_napi_get_call_sites(napi_env env,
                                                      uint32_t frames,
                                                      napi_value* callsites_out) {
  return GetCallSitesImpl(env, frames, 1, callsites_out);
}

napi_status NAPI_CDECL unofficial_napi_arraybuffer_view_has_buffer(napi_env env,
                                                                   napi_value value,
                                                                   bool* result_out) {
  if (env == nullptr || value == nullptr || result_out == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(value);
  if (raw.IsEmpty() || !raw->IsArrayBufferView()) return napi_invalid_arg;
  *result_out = raw.As<v8::ArrayBufferView>()->HasBuffer();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_constructor_name(napi_env env,
                                                            napi_value value,
                                                            napi_value* name_out) {
  if (env == nullptr || value == nullptr || name_out == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(value);
  if (raw.IsEmpty() || !raw->IsObject()) return napi_invalid_arg;
  v8::Local<v8::String> name = raw.As<v8::Object>()->GetConstructorName();
  *name_out = napi_v8_wrap_value(env, name);
  return *name_out == nullptr ? napi_generic_failure : napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_create_private_symbol(napi_env env,
                                                             const char* utf8description,
                                                             size_t length,
                                                             napi_value* result_out) {
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr) return napi_invalid_arg;
  if (utf8description == nullptr && length > 0) return napi_invalid_arg;

  v8::Isolate* isolate = env->isolate;
  v8::EscapableHandleScope scope(isolate);
  v8::Local<v8::Context> context = env->context();

  const char* description = utf8description != nullptr ? utf8description : "";
  const int v8_length = (length == NAPI_AUTO_LENGTH) ? -1 : static_cast<int>(length);
  v8::Local<v8::String> desc;
  if (!v8::String::NewFromUtf8(isolate, description, v8::NewStringType::kInternalized, v8_length)
           .ToLocal(&desc)) {
    return napi_generic_failure;
  }

  v8::Local<v8::Private> priv = v8::Private::ForApi(isolate, desc);
  v8::Local<v8::ObjectTemplate> tmpl = v8::ObjectTemplate::New(isolate);
  tmpl->Set(v8::String::NewFromUtf8Literal(isolate, "value"), priv);

  v8::Local<v8::Object> holder;
  if (!tmpl->NewInstance(context).ToLocal(&holder)) {
    return napi_generic_failure;
  }

  v8::Local<v8::Value> symbol_value;
  if (!holder->Get(context, v8::String::NewFromUtf8Literal(isolate, "value")).ToLocal(&symbol_value)) {
    return napi_generic_failure;
  }

  *result_out = napi_v8_wrap_value(env, scope.Escape(symbol_value));
  return *result_out == nullptr ? napi_generic_failure : napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_own_non_index_properties(
    napi_env env,
    napi_value value,
    uint32_t filter_bits,
    napi_value* result_out) {
  if (env == nullptr || value == nullptr || result_out == nullptr) {
    return napi_invalid_arg;
  }
  v8::Local<v8::Value> raw = napi_v8_unwrap_value(value);
  if (raw.IsEmpty() || !raw->IsObject()) return napi_object_expected;

  v8::TryCatch try_catch(env->isolate);
  v8::Local<v8::Array> properties;
  if (!raw.As<v8::Object>()
           ->GetPropertyNames(env->context(),
                              v8::KeyCollectionMode::kOwnOnly,
                              static_cast<v8::PropertyFilter>(filter_bits),
                              v8::IndexFilter::kSkipIndices)
           .ToLocal(&properties)) {
    if (try_catch.HasCaught()) {
      napi_v8_set_last_exception(
          env, try_catch.Exception(), try_catch.Message());
      return napi_pending_exception;
    }
    return napi_generic_failure;
  }

  *result_out = napi_v8_wrap_value(env, properties);
  return *result_out == nullptr ? napi_generic_failure : napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_hash_seed(napi_env env,
                                                     uint64_t* hash_seed_out) {
  if (env == nullptr || env->isolate == nullptr || hash_seed_out == nullptr) {
    return napi_invalid_arg;
  }
  {
    RuntimeLock lock;
    auto it = g_hash_seeds.find(env->isolate);
    if (it != g_hash_seeds.end()) {
      *hash_seed_out = it->second;
      return napi_ok;
    }
  }
  *hash_seed_out = env->isolate->GetHashSeed();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_heap_statistics(
    napi_env env,
    unofficial_napi_heap_statistics* stats_out) {
  if (env == nullptr || env->isolate == nullptr || stats_out == nullptr ||
      stats_out->size < sizeof(*stats_out) ||
      stats_out->version != UNOFFICIAL_NAPI_HEAP_STATISTICS_VERSION) {
    return napi_invalid_arg;
  }

  v8::HeapStatistics stats;
  env->isolate->GetHeapStatistics(&stats);

  const uint32_t output_size = stats_out->size;
  std::memset(stats_out, 0, sizeof(*stats_out));
  stats_out->size = output_size;
  stats_out->version = UNOFFICIAL_NAPI_HEAP_STATISTICS_VERSION;
  stats_out->valid_fields = unofficial_napi_heap_stat_all;
  stats_out->total_heap_size = stats.total_heap_size();
  stats_out->total_heap_size_executable = stats.total_heap_size_executable();
  stats_out->total_physical_size = stats.total_physical_size();
  stats_out->total_available_size = stats.total_available_size();
  stats_out->used_heap_size = stats.used_heap_size();
  stats_out->heap_size_limit = stats.heap_size_limit();
  stats_out->does_zap_garbage = stats.does_zap_garbage();
  stats_out->malloced_memory = stats.malloced_memory();
  stats_out->peak_malloced_memory = stats.peak_malloced_memory();
  stats_out->number_of_native_contexts = stats.number_of_native_contexts();
  stats_out->number_of_detached_contexts = stats.number_of_detached_contexts();
  stats_out->total_global_handles_size = stats.total_global_handles_size();
  stats_out->used_global_handles_size = stats.used_global_handles_size();
  stats_out->external_memory = stats.external_memory();
  stats_out->array_buffer_memory = 0;
  {
    RuntimeLock lock;
    auto it = g_tracking_allocators.find(env->isolate->GetArrayBufferAllocator());
    if (it != g_tracking_allocators.end() && it->second) {
      stats_out->array_buffer_memory = it->second->total_mem_usage();
    }
  }
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_heap_space_statistics(
    napi_env env,
    unofficial_napi_heap_space_statistics* stats_out,
    uint32_t capacity,
    uint32_t* count_out) {
  if (env == nullptr || env->isolate == nullptr || count_out == nullptr ||
      (capacity > 0 && stats_out == nullptr)) {
    return napi_invalid_arg;
  }

  const uint32_t space_count =
      static_cast<uint32_t>(env->isolate->NumberOfHeapSpaces());
  *count_out = space_count;
  const uint32_t output_count = std::min(capacity, space_count);
  for (uint32_t space_index = 0; space_index < output_count; ++space_index) {
    v8::HeapSpaceStatistics stats;
    env->isolate->GetHeapSpaceStatistics(&stats, space_index);

    auto& output = stats_out[space_index];
    std::snprintf(output.space_name,
                  sizeof(output.space_name),
                  "%s",
                  stats.space_name() != nullptr ? stats.space_name() : "");
    output.space_size = stats.space_size();
    output.space_used_size = stats.space_used_size();
    output.space_available_size = stats.space_available_size();
    output.physical_space_size = stats.physical_space_size();
  }
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_get_heap_code_statistics(
    napi_env env,
    unofficial_napi_heap_code_statistics* stats_out) {
  if (env == nullptr || env->isolate == nullptr || stats_out == nullptr) {
    return napi_invalid_arg;
  }

  v8::HeapCodeStatistics stats;
  env->isolate->GetHeapCodeAndMetadataStatistics(&stats);

  stats_out->code_and_metadata_size = stats.code_and_metadata_size();
  stats_out->bytecode_and_metadata_size = stats.bytecode_and_metadata_size();
  stats_out->external_script_source_size = stats.external_script_source_size();
  stats_out->cpu_profiler_metadata_size = stats.cpu_profiler_metadata_size();
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_profile_start(
    napi_env env,
    unofficial_napi_profile_kind kind,
    unofficial_napi_profile_start_result* result_out,
    unofficial_napi_profile* profile_out) {
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr ||
      profile_out == nullptr ||
      (kind != unofficial_napi_profile_cpu &&
       kind != unofficial_napi_profile_heap)) {
    return napi_invalid_arg;
  }
  *result_out = unofficial_napi_profile_start_ok;
  *profile_out = nullptr;
  if (!IsEnvThreadEntered(env)) return napi_cannot_run_js;

  if (kind == unofficial_napi_profile_heap) {
    {
      RuntimeLock lock;
      auto it = g_profiler_states.find(env);
      if (it != g_profiler_states.end() &&
          std::any_of(it->second.active_profiles.begin(),
                      it->second.active_profiles.end(),
                      [](unofficial_napi_profile profile) {
                        return profile != nullptr &&
                               profile->kind == unofficial_napi_profile_heap;
                      })) {
        *result_out = unofficial_napi_profile_start_busy;
        return napi_ok;
      }
    }
    if (!env->isolate->GetHeapProfiler()->StartSamplingHeapProfiler()) {
      *result_out = unofficial_napi_profile_start_busy;
      return napi_ok;
    }
    auto* profile = new (std::nothrow) unofficial_napi_profile__;
    if (profile == nullptr) {
      env->isolate->GetHeapProfiler()->StopSamplingHeapProfiler();
      return napi_generic_failure;
    }
    profile->kind = kind;
    {
      RuntimeLock lock;
      EnsureProfilerState(env).active_profiles.push_back(profile);
    }
    *profile_out = profile;
    return napi_ok;
  }

  v8::CpuProfiler* cpu_profiler = nullptr;
  {
    RuntimeLock lock;
    ProfilerState& state = EnsureProfilerState(env);
    if (state.cpu_profiler == nullptr) {
      state.cpu_profiler = v8::CpuProfiler::New(env->isolate);
      if (state.cpu_profiler == nullptr) return napi_generic_failure;
    }
    cpu_profiler = state.cpu_profiler;
  }

  v8::CpuProfilingResult result = cpu_profiler->Start(
      v8::CpuProfilingOptions{v8::CpuProfilingMode::kLeafNodeLineNumbers,
                              v8::CpuProfilingOptions::kNoSampleLimit});
  if (result.status == v8::CpuProfilingStatus::kErrorTooManyProfilers) {
    *result_out = unofficial_napi_profile_start_busy;
    return napi_ok;
  }
  if (result.status != v8::CpuProfilingStatus::kStarted) {
    return napi_generic_failure;
  }

  auto* profile = new (std::nothrow) unofficial_napi_profile__;
  if (profile == nullptr) {
    if (v8::CpuProfile* stopped = cpu_profiler->Stop(result.id)) {
      stopped->Delete();
    }
    return napi_generic_failure;
  }
  profile->kind = kind;
  profile->provider_id = static_cast<uint32_t>(result.id);
  {
    RuntimeLock lock;
    auto it = g_profiler_states.find(env);
    if (it != g_profiler_states.end()) {
      it->second.active_profiles.push_back(profile);
    }
  }
  *profile_out = profile;
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_profile_stop(
    napi_env env,
    unofficial_napi_profile profile,
    napi_value* json_out) {
  if (env == nullptr || env->isolate == nullptr || profile == nullptr ||
      json_out == nullptr) {
    return napi_invalid_arg;
  }
  *json_out = nullptr;
  if (!IsEnvThreadEntered(env)) return napi_cannot_run_js;

  v8::CpuProfiler* cpu_profiler = nullptr;
  unofficial_napi_profile_kind kind = unofficial_napi_profile_cpu;
  uint32_t provider_id = 0;
  {
    RuntimeLock lock;
    auto it = g_profiler_states.find(env);
    if (it == g_profiler_states.end()) return napi_invalid_arg;
    auto active_it = std::find(it->second.active_profiles.begin(),
                               it->second.active_profiles.end(), profile);
    if (active_it == it->second.active_profiles.end()) return napi_invalid_arg;
    kind = profile->kind;
    provider_id = profile->provider_id;
    it->second.active_profiles.erase(active_it);
    cpu_profiler = it->second.cpu_profiler;
  }

  if (kind == unofficial_napi_profile_heap) {
    std::string json;
    const bool serialized = SerializeHeapProfile(env->isolate, &json);
    env->isolate->GetHeapProfiler()->StopSamplingHeapProfiler();
    delete profile;
    if (!serialized) return napi_generic_failure;
    return CreateExternalUtf8Bytes(env, std::move(json), json_out);
  }

  if (cpu_profiler == nullptr) {
    delete profile;
    return napi_generic_failure;
  }
  v8::CpuProfile* cpu_profile = cpu_profiler->Stop(provider_id);
  delete profile;
  if (cpu_profile == nullptr) return napi_generic_failure;
  StringOutputStream stream;
  cpu_profile->Serialize(&stream, v8::CpuProfile::SerializationFormat::kJSON);
  cpu_profile->Delete();
  return CreateExternalUtf8Bytes(env, stream.TakeOutput(), json_out);
}

napi_status NAPI_CDECL unofficial_napi_take_heap_snapshot(
    napi_env env,
    const unofficial_napi_heap_snapshot_options* options,
    napi_value* json_out) {
  if (env == nullptr || env->isolate == nullptr || json_out == nullptr) {
    return napi_invalid_arg;
  }
  *json_out = nullptr;
  if (!IsEnvThreadEntered(env)) return napi_cannot_run_js;

  v8::HeapProfiler::HeapSnapshotOptions snapshot_options;
  snapshot_options.snapshot_mode =
      (options != nullptr && options->expose_internals)
          ? v8::HeapProfiler::HeapSnapshotMode::kExposeInternals
          : v8::HeapProfiler::HeapSnapshotMode::kRegular;
  snapshot_options.numerics_mode =
      (options != nullptr && options->expose_numeric_values)
          ? v8::HeapProfiler::NumericsMode::kExposeNumericValues
          : v8::HeapProfiler::NumericsMode::kHideNumericValues;

  const v8::HeapSnapshot* snapshot =
      env->isolate->GetHeapProfiler()->TakeHeapSnapshot(snapshot_options);
  if (snapshot == nullptr) return napi_generic_failure;

  StringOutputStream stream;
  snapshot->Serialize(&stream, v8::HeapSnapshot::kJSON);
  const_cast<v8::HeapSnapshot*>(snapshot)->Delete();
  return CreateExternalUtf8Bytes(env, stream.TakeOutput(), json_out);
}

napi_status NAPI_CDECL unofficial_napi_get_continuation_preserved_embedder_data(
    napi_env env,
    napi_value* result_out) {
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> value = env->isolate->GetContinuationPreservedEmbedderData();
  if (value.IsEmpty()) value = v8::Undefined(env->isolate);
  *result_out = napi_v8_wrap_value(env, value);
  return *result_out == nullptr ? napi_generic_failure : napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_set_continuation_preserved_embedder_data(
    napi_env env,
    napi_value value) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
  v8::Local<v8::Value> raw =
      value != nullptr ? napi_v8_unwrap_value(value) : v8::Local<v8::Value>();
  if (raw.IsEmpty()) raw = v8::Undefined(env->isolate);
  env->isolate->SetContinuationPreservedEmbedderData(raw);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_notify_datetime_configuration_change(napi_env env) {
  if (env == nullptr || env->isolate == nullptr) return napi_invalid_arg;
#if defined(__POSIX__)
  tzset();
#elif defined(_WIN32)
  _tzset();
#endif
  env->isolate->DateTimeConfigurationChangeNotification(
      v8::Isolate::TimeZoneDetection::kRedetect);
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_create_serdes_binding(napi_env env,
                                                             napi_value* result_out) {
  if (env == nullptr || env->isolate == nullptr || result_out == nullptr) return napi_invalid_arg;

  v8::Isolate* isolate = env->isolate;
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = env->context();
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Object> target = v8::Object::New(isolate);
  v8::Local<v8::External> env_data = v8::External::New(isolate, env);

  v8::Local<v8::FunctionTemplate> serializer_tmpl =
      v8::FunctionTemplate::New(isolate, SerializerContext::New, env_data);
  serializer_tmpl->InstanceTemplate()->SetInternalFieldCount(1);
  serializer_tmpl->SetClassName(OneByteString(isolate, "Serializer"));
  SetProtoMethod(isolate, serializer_tmpl, "writeHeader", SerializerContext::WriteHeader);
  SetProtoMethod(isolate, serializer_tmpl, "writeValue", SerializerContext::WriteValue);
  SetProtoMethod(isolate, serializer_tmpl, "releaseBuffer", SerializerContext::ReleaseBuffer);
  SetProtoMethod(isolate, serializer_tmpl, "transferArrayBuffer", SerializerContext::TransferArrayBuffer);
  SetProtoMethod(isolate, serializer_tmpl, "writeUint32", SerializerContext::WriteUint32);
  SetProtoMethod(isolate, serializer_tmpl, "writeUint64", SerializerContext::WriteUint64);
  SetProtoMethod(isolate, serializer_tmpl, "writeDouble", SerializerContext::WriteDouble);
  SetProtoMethod(isolate, serializer_tmpl, "writeRawBytes", SerializerContext::WriteRawBytes);
  SetProtoMethod(isolate,
                 serializer_tmpl,
                 "_setTreatArrayBufferViewsAsHostObjects",
                 SerializerContext::SetTreatArrayBufferViewsAsHostObjects);
  serializer_tmpl->ReadOnlyPrototype();
  if (!SetConstructorFunction(context, target, "Serializer", serializer_tmpl)) {
    return napi_generic_failure;
  }

  v8::Local<v8::FunctionTemplate> deserializer_tmpl =
      v8::FunctionTemplate::New(isolate, DeserializerContext::New, env_data);
  deserializer_tmpl->InstanceTemplate()->SetInternalFieldCount(1);
  deserializer_tmpl->SetClassName(OneByteString(isolate, "Deserializer"));
  SetProtoMethod(isolate, deserializer_tmpl, "readHeader", DeserializerContext::ReadHeader);
  SetProtoMethod(isolate, deserializer_tmpl, "readValue", DeserializerContext::ReadValue);
  SetProtoMethod(
      isolate, deserializer_tmpl, "getWireFormatVersion", DeserializerContext::GetWireFormatVersion);
  SetProtoMethod(
      isolate, deserializer_tmpl, "transferArrayBuffer", DeserializerContext::TransferArrayBuffer);
  SetProtoMethod(isolate, deserializer_tmpl, "readUint32", DeserializerContext::ReadUint32);
  SetProtoMethod(isolate, deserializer_tmpl, "readUint64", DeserializerContext::ReadUint64);
  SetProtoMethod(isolate, deserializer_tmpl, "readDouble", DeserializerContext::ReadDouble);
  SetProtoMethod(isolate, deserializer_tmpl, "_readRawBytes", DeserializerContext::ReadRawBytes);
  deserializer_tmpl->SetLength(1);
  deserializer_tmpl->ReadOnlyPrototype();
  if (!SetConstructorFunction(context, target, "Deserializer", deserializer_tmpl)) {
    return napi_generic_failure;
  }

  *result_out = napi_v8_wrap_value(env, target);
  return (*result_out == nullptr) ? napi_generic_failure : napi_ok;
}

}  // extern "C"
