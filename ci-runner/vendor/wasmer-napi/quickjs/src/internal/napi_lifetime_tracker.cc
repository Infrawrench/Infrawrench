#include "internal/napi_lifetime_tracker.h"

#include "internal/napi_deferred.h"
#include "internal/napi_env.h"
#include "internal/napi_env_cleanup_hook.h"
#include "internal/napi_external_backing_store_hint.h"
#include "internal/napi_ref.h"
#include "internal/napi_scope.h"
#include "internal/napi_value.h"
#include <napi_lifetime_tracker.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace quickjs::detail
{
namespace
{
bool enabled()
{
  return napi::lifetime::env_flag_enabled("EDGE_TRACE_NAPI_LIFETIME");
}

bool periodic_stats_enabled()
{
  return napi::lifetime::env_flag_enabled_or("EDGE_TRACE_NAPI_LIFETIME_STATS", enabled());
}

int64_t monotonic_milliseconds()
{
  return napi::lifetime::monotonic_milliseconds();
}

#if defined(NAPI_ENABLE_LIFETIME_TAG_STATS) || \
    defined(NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP)
constexpr int k_min_known_tag = -9;
constexpr int k_max_known_tag = 8;
constexpr size_t k_known_tag_count =
    static_cast<size_t>(k_max_known_tag - k_min_known_tag + 1);
constexpr size_t k_unknown_tag_index = k_known_tag_count;
constexpr size_t k_tag_bucket_count = k_known_tag_count + 1;

size_t tag_bucket_index(int tag)
{
  if (tag < k_min_known_tag || tag > k_max_known_tag)
    return k_unknown_tag_index;
  return static_cast<size_t>(tag - k_min_known_tag);
}

const char *tag_bucket_name(size_t index)
{
  if (index == k_unknown_tag_index)
    return "unknown";

  switch (static_cast<int>(index) + k_min_known_tag)
  {
  case -9:
    return "big_int";
  case -8:
    return "symbol";
  case -7:
    return "string";
  case -6:
    return "string_rope";
  case -5:
    return "tag_-5";
  case -4:
    return "tag_-4";
  case -3:
    return "module";
  case -2:
    return "function_bytecode";
  case -1:
    return "object";
  case 0:
    return "int";
  case 1:
    return "bool";
  case 2:
    return "null";
  case 3:
    return "undefined";
  case 4:
    return "uninitialized";
  case 5:
    return "catch_offset";
  case 6:
    return "exception";
  case 7:
    return "short_big_int";
  case 8:
    return "float64";
  default:
    return "unknown";
  }
}

struct tag_counters
{
  size_t slots[k_tag_bucket_count] = {};
};

void add_tag(tag_counters &counters, int tag)
{
  ++counters.slots[tag_bucket_index(tag)];
}

void remove_tag(tag_counters &counters, int tag)
{
  size_t &slot = counters.slots[tag_bucket_index(tag)];
  if (slot > 0)
    --slot;
}

bool has_tags(const tag_counters &counters)
{
  for (size_t i = 0; i < k_tag_bucket_count; ++i)
  {
    if (counters.slots[i] != 0)
      return true;
  }
  return false;
}
#endif

#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
void clear_exception(JSContext *ctx)
{
  if (ctx == nullptr || !JS_HasException(ctx))
    return;
  JSValue exception = JS_GetException(ctx);
  JS_FreeValue(ctx, exception);
}

bool js_value_to_escaped_string(JSContext *ctx, JSValueConst value, std::string &out)
{
  size_t text_length = 0;
  const char *text = JS_ToCStringLen(ctx, &text_length, value);
  if (text == nullptr)
  {
    clear_exception(ctx);
    return false;
  }

  out = napi::lifetime::escaped_value_fragment(text, text_length);
  JS_FreeCString(ctx, text);
  return true;
}

std::string class_name_fallback(JSContext *ctx, JSValueConst value)
{
  JSRuntime *rt = JS_GetRuntime(ctx);
  JSClassID class_id = JS_GetClassID(value);
  JSAtom class_name = JS_GetClassName(rt, class_id);
  if (class_name == JS_ATOM_NULL)
    return "<object>";

  const char *text = JS_AtomToCString(ctx, class_name);
  std::string result = text == nullptr
                           ? "<object>"
                           : napi::lifetime::escaped_value_fragment(
                                 text, std::strlen(text));
  if (text != nullptr)
    JS_FreeCString(ctx, text);
  JS_FreeAtomRT(rt, class_name);
  clear_exception(ctx);
  return result.empty() ? "<object>" : result;
}

std::string object_prototype_name(napi_env env, JSValueConst value)
{
  JSContext *ctx = env->context();
  JSValue proto = JS_GetPrototype(ctx, value);
  if (JS_IsException(proto))
  {
    clear_exception(ctx);
    return class_name_fallback(ctx, value);
  }

  if (JS_IsNull(proto) || JS_IsUndefined(proto))
  {
    JS_FreeValue(ctx, proto);
    return "<null-prototype>";
  }

  JSValue ctor = JS_GetPropertyStr(ctx, proto, "constructor");
  JS_FreeValue(ctx, proto);
  if (JS_IsException(ctor))
  {
    clear_exception(ctx);
    return class_name_fallback(ctx, value);
  }

  JSValue name = JS_UNDEFINED;
  if (JS_IsObject(ctor))
    name = JS_GetPropertyStr(ctx, ctor, "name");
  JS_FreeValue(ctx, ctor);
  if (JS_IsException(name))
  {
    clear_exception(ctx);
    return class_name_fallback(ctx, value);
  }

  std::string result;
  bool has_name = !JS_IsUndefined(name) &&
                  !JS_IsNull(name) &&
                  js_value_to_escaped_string(ctx, name, result) &&
                  !result.empty();
  JS_FreeValue(ctx, name);

  return has_name ? result : class_name_fallback(ctx, value);
}
#endif

struct value_snapshot
{
  napi_env env = nullptr;
  int tag = JS_TAG_UNDEFINED;
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  bool has_string_symbol = false;
  std::string string_symbol_value;
  bool has_object_type = false;
  std::string object_type;
#endif
};

using basic_snapshot = napi::lifetime::basic_snapshot<napi_env>;

template <typename Snapshot>
using tracked_type_stats = napi::lifetime::tracked_type_stats<Snapshot>;

struct value_type_stats : tracked_type_stats<value_snapshot>
{
#ifdef NAPI_ENABLE_LIFETIME_TAG_STATS
  tag_counters tags;
#endif
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  std::vector<napi::lifetime::string_symbol_entry<int>> string_symbols;
  std::vector<napi::lifetime::object_type_entry> object_types;
#endif
};

struct lifetime_stats
{
  std::mutex mutex;
  value_type_stats values;
  value_type_stats refs;
  tracked_type_stats<basic_snapshot> cleanup_hooks;
  tracked_type_stats<basic_snapshot> deferreds;
  tracked_type_stats<basic_snapshot> external_backing_store_hints;
  size_t scope_escape_calls = 0;
  size_t scope_escape_succeeded = 0;
  size_t scope_escape_failed = 0;
  napi::lifetime::counter_history counters;
};

lifetime_stats g_lifetime;

value_snapshot capture_value_snapshot(napi_env env, JSValueConst value)
{
  value_snapshot snapshot;
  snapshot.env = env;
  snapshot.tag = JS_VALUE_GET_NORM_TAG(value);

#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  if (env != nullptr && env->context() != nullptr)
  {
    JSContext *ctx = env->context();
    if ((snapshot.tag == JS_TAG_STRING ||
         snapshot.tag == JS_TAG_STRING_ROPE) &&
        js_value_to_escaped_string(ctx, value, snapshot.string_symbol_value))
    {
      snapshot.has_string_symbol = true;
    }

    if (snapshot.tag == JS_TAG_OBJECT)
    {
      snapshot.object_type = object_prototype_name(env, value);
      snapshot.has_object_type = true;
    }
  }
#endif

  return snapshot;
}

void add_value_snapshot(value_type_stats &stats, const value_snapshot &snapshot)
{
#ifdef NAPI_ENABLE_LIFETIME_TAG_STATS
  add_tag(stats.tags, snapshot.tag);
#endif
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  if (snapshot.has_string_symbol)
    napi::lifetime::add_string_symbol_entry(stats.string_symbols,
                                            snapshot.tag,
                                            snapshot.string_symbol_value);
  if (snapshot.has_object_type)
    napi::lifetime::add_object_type_entry(stats.object_types, snapshot.object_type);
#endif
}

void remove_value_snapshot(value_type_stats &stats, const value_snapshot &snapshot)
{
#ifdef NAPI_ENABLE_LIFETIME_TAG_STATS
  remove_tag(stats.tags, snapshot.tag);
#endif
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  if (snapshot.has_string_symbol)
    napi::lifetime::remove_string_symbol_entry(stats.string_symbols,
                                               snapshot.tag,
                                               snapshot.string_symbol_value);
  if (snapshot.has_object_type)
    napi::lifetime::remove_object_type_entry(stats.object_types, snapshot.object_type);
#endif
}

napi::lifetime::env_slot_scan scan_env_slots(napi_env env)
{
  napi::lifetime::env_slot_scan scan;
  if (env == nullptr)
    return scan;

  scan.scope_slots_total = env->scope_storage_slot_count();
  scan.active_scopes = env->active_scope_count();
  scan.ref_slots_total = env->ref_storage_slot_count();
  scan.active_refs = env->active_ref_count();
  std::unordered_map<size_t, size_t> active_values_by_scope_level;
  env->for_each_active_scope([&](const napi_scope__ &scope) {
    size_t active_values = scope.active_value_count();
    scan.value_slots_total += scope.value_storage_slot_count();
    scan.active_values += active_values;
    active_values_by_scope_level[scope.level()] += active_values;
  });
  scan.active_values_by_scope_level.reserve(active_values_by_scope_level.size());
  for (const auto &[level, count] : active_values_by_scope_level)
    scan.active_values_by_scope_level.push_back({level, count});
  std::sort(scan.active_values_by_scope_level.begin(),
            scan.active_values_by_scope_level.end(),
            [](const auto &left, const auto &right) {
              return left.first < right.first;
            });
  return scan;
}

void dump_stats_locked(napi_env env, bool include_string_symbol_values)
{
  napi::lifetime::dump_lifetime_header();
  napi::lifetime::env_slot_scan scan = scan_env_slots(env);
  napi::lifetime::dump_slots_table(g_lifetime.counters,
                                   scan,
                                   g_lifetime.values.active,
                                   g_lifetime.refs.active,
                                   g_lifetime.scope_escape_calls,
                                   g_lifetime.scope_escape_succeeded,
                                   g_lifetime.scope_escape_failed);
  napi::lifetime::dump_scope_level_table(g_lifetime.counters, scan);

  napi::lifetime::dump_type_table_header();
  napi::lifetime::dump_type_row(g_lifetime.counters, "napi_value", g_lifetime.values);
  napi::lifetime::dump_type_row(g_lifetime.counters, "napi_ref", g_lifetime.refs);
  napi::lifetime::dump_type_row(g_lifetime.counters,
                                "napi_env_cleanup_hook",
                                g_lifetime.cleanup_hooks);
  napi::lifetime::dump_type_row(g_lifetime.counters, "napi_deferred", g_lifetime.deferreds);
  napi::lifetime::dump_type_row(g_lifetime.counters,
                                "napi_external_backing_store_hint",
                                g_lifetime.external_backing_store_hints);

#ifdef NAPI_ENABLE_LIFETIME_TAG_STATS
  napi::lifetime::dump_tag_table(g_lifetime.counters,
                                 "napi_value",
                                 g_lifetime.values.tags,
                                 k_tag_bucket_count,
                                 tag_bucket_name);
  napi::lifetime::dump_tag_table(g_lifetime.counters,
                                 "napi_ref",
                                 g_lifetime.refs.tags,
                                 k_tag_bucket_count,
                                 tag_bucket_name);
#endif
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  if (include_string_symbol_values)
  {
    napi::lifetime::dump_string_entries(g_lifetime.counters,
                                        g_lifetime.values.string_symbols,
                                        [](int tag) {
                                          return tag == JS_TAG_STRING || tag == JS_TAG_STRING_ROPE;
                                        },
                                        "napi_value");
    napi::lifetime::dump_object_type_entries(g_lifetime.counters,
                                             g_lifetime.values.object_types,
                                             g_lifetime.refs.object_types);
  }
#else
  (void)include_string_symbol_values;
#endif
  std::fprintf(stderr, "\n");
}

void dump_summary_locked(napi_env env)
{
  napi::lifetime::dump_summary_row(scan_env_slots(env));
}

void dump_lifetime(napi_env env, const char *reason, bool include_string_symbol_values)
{
  if (reason != nullptr)
    std::fprintf(stderr, "[napi-lifetime] dump env=%p reason=%s\n", env, reason);

  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  dump_stats_locked(env, include_string_symbol_values);
}

void dump_lifetime_summary(napi_env env)
{
  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  dump_summary_locked(env);
}

#ifdef NAPI_ENABLE_LIFETIME_PERIODIC_STATS
void maybe_dump_periodic_stats(napi_env env)
{
  if (env == nullptr || !periodic_stats_enabled())
    return;

  int64_t now = monotonic_milliseconds();
  bool should_dump_summary = env->should_dump_lifetime_stats(now);
  bool should_dump_full = false;
#ifdef NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP
  should_dump_full = env->should_dump_lifetime_string_symbol_values(now);
#endif

  if (should_dump_full)
  {
    dump_lifetime(env, nullptr, true);
    return;
  }

  if (should_dump_summary)
    dump_lifetime_summary(env);
}
#else
void maybe_dump_periodic_stats(napi_env env)
{
  (void)env;
}
#endif

void record_value_create(value_type_stats &stats,
                         const void *handle,
                         value_snapshot snapshot)
{
  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  napi::lifetime::record_tracked_create(stats,
                                        handle,
                                        std::move(snapshot),
                                        add_value_snapshot);
}

napi_env record_value_release(value_type_stats &stats, const void *handle)
{
  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  return napi::lifetime::record_tracked_release<napi_env>(stats,
                                                          handle,
                                                          remove_value_snapshot);
}

void record_basic_create(tracked_type_stats<basic_snapshot> &stats,
                         const void *handle,
                         basic_snapshot snapshot)
{
  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  napi::lifetime::record_tracked_create(stats,
                                        handle,
                                        std::move(snapshot),
                                        napi::lifetime::add_basic_snapshot<basic_snapshot>);
}

napi_env record_basic_release(tracked_type_stats<basic_snapshot> &stats,
                              const void *handle)
{
  std::lock_guard<std::mutex> lock{g_lifetime.mutex};
  return napi::lifetime::record_tracked_release<napi_env>(
      stats,
      handle,
      napi::lifetime::remove_basic_snapshot<basic_snapshot>);
}
} // namespace

void napi_lifetime__<napi_value__>::record_create(napi_scope__ *owner, napi_value__ *val)
{
  if (owner == nullptr || val == nullptr)
    return;

  napi_env env = owner->env();
  value_snapshot snapshot = capture_value_snapshot(env, val->get_inner());
  record_value_create(g_lifetime.values, val, std::move(snapshot));
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_value__>::record_release(napi_scope__ *owner, napi_value__ *val)
{
  (void)owner;
  napi_env env = record_value_release(g_lifetime.values, val);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_ref__>::record_create(napi_env__ *owner, napi_ref__ *val)
{
  if (owner == nullptr || val == nullptr)
    return;

  value_snapshot snapshot = capture_value_snapshot(owner, val->get_inner());
  napi_env env = snapshot.env;
  record_value_create(g_lifetime.refs, val, std::move(snapshot));
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_ref__>::record_release(napi_env__ *owner, napi_ref__ *val)
{
  (void)owner;
  napi_env env = record_value_release(g_lifetime.refs, val);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_env_cleanup_hook__>::record_create(
    napi_env__ *owner,
    napi_env_cleanup_hook__ *val)
{
  if (owner == nullptr || val == nullptr)
    return;

  basic_snapshot snapshot{owner};
  napi_env env = snapshot.env;
  record_basic_create(g_lifetime.cleanup_hooks, val, snapshot);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_env_cleanup_hook__>::record_release(
    napi_env__ *owner,
    napi_env_cleanup_hook__ *val)
{
  (void)owner;
  napi_env env = record_basic_release(g_lifetime.cleanup_hooks, val);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_deferred__>::record_create(napi_env__ *owner, napi_deferred__ *val)
{
  if (owner == nullptr || val == nullptr)
    return;

  basic_snapshot snapshot{owner};
  napi_env env = snapshot.env;
  record_basic_create(g_lifetime.deferreds, val, snapshot);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_deferred__>::record_release(napi_env__ *owner, napi_deferred__ *val)
{
  (void)owner;
  napi_env env = record_basic_release(g_lifetime.deferreds, val);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_external_backing_store_hint__>::record_create(
    napi_env__ *owner,
    napi_external_backing_store_hint__ *val)
{
  if (owner == nullptr || val == nullptr)
    return;

  basic_snapshot snapshot{owner};
  napi_env env = snapshot.env;
  record_basic_create(g_lifetime.external_backing_store_hints, val, snapshot);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime__<napi_external_backing_store_hint__>::record_release(
    napi_env__ *owner,
    napi_external_backing_store_hint__ *val)
{
  (void)owner;
  napi_env env = record_basic_release(g_lifetime.external_backing_store_hints, val);
  maybe_dump_periodic_stats(env);
}

void napi_lifetime_tracker__::record_scope_escape(napi_env env, bool succeeded)
{
  {
    std::lock_guard<std::mutex> lock{g_lifetime.mutex};
    ++g_lifetime.scope_escape_calls;
    if (succeeded)
      ++g_lifetime.scope_escape_succeeded;
    else
      ++g_lifetime.scope_escape_failed;
  }
  maybe_dump_periodic_stats(env);
}

void napi_lifetime_tracker__::dump(napi_env env, const char *reason)
{
  if (env == nullptr || (!enabled() && !periodic_stats_enabled()))
    return;

  dump_lifetime(env, reason, true);
}
} // namespace quickjs::detail

extern "C" void napi_quickjs_lifetime_dump(napi_env env, const char *reason)
{
  quickjs::detail::napi_lifetime_tracker__::dump(env, reason);
}
