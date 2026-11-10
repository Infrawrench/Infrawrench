// ============================================================
// C++ bridge FFI declarations (from napi_bridge_init.cc)
// ============================================================

use core::ffi::c_void;

#[repr(C)]
pub struct SnapiEnvState {
    _private: [u8; 0],
}

pub type SnapiEnv = *mut SnapiEnvState;

#[repr(C)]
pub struct SnapiUnofficialHeapStatistics {
    pub size: u32,
    pub version: u32,
    pub valid_fields: u64,
    pub total_heap_size: u64,
    pub total_heap_size_executable: u64,
    pub total_physical_size: u64,
    pub total_available_size: u64,
    pub used_heap_size: u64,
    pub heap_size_limit: u64,
    pub does_zap_garbage: u64,
    pub malloced_memory: u64,
    pub peak_malloced_memory: u64,
    pub number_of_native_contexts: u64,
    pub number_of_detached_contexts: u64,
    pub total_global_handles_size: u64,
    pub used_global_handles_size: u64,
    pub external_memory: u64,
    pub array_buffer_memory: u64,
}

#[repr(C)]
pub struct SnapiUnofficialHeapSpaceStatistics {
    pub space_name: [u8; 64],
    pub space_size: u64,
    pub space_used_size: u64,
    pub space_available_size: u64,
    pub physical_space_size: u64,
}

#[repr(C)]
pub struct SnapiUnofficialHeapCodeStatistics {
    pub code_and_metadata_size: u64,
    pub bytecode_and_metadata_size: u64,
    pub external_script_source_size: u64,
    pub cpu_profiler_metadata_size: u64,
}

unsafe extern "C" {
    pub fn snapi_bridge_init() -> i32;
    pub fn snapi_bridge_set_v8_worker_thread_count(count: u32) -> i32;
    pub fn snapi_bridge_unofficial_configure_runtime(
        engine_flags: *const std::ffi::c_char,
        engine_flags_length: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_create_env(
        module_api_version: i32,
        guest_heap_ctx: *const core::ffi::c_void,
        env_out: *mut SnapiEnv,
    ) -> i32;
    pub fn snapi_bridge_unofficial_create_env_with_options(
        module_api_version: i32,
        total_memory: u64,
        constrained_memory: u64,
        max_young_generation_size_in_bytes: u32,
        max_old_generation_size_in_bytes: u32,
        code_range_size_in_bytes: u32,
        stack_limit: u32,
        guest_heap_ctx: *const core::ffi::c_void,
        env_out: *mut SnapiEnv,
    ) -> i32;
    pub fn snapi_bridge_unofficial_release_env(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_unofficial_release_env_with_loop(env: SnapiEnv, loop_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_collect_garbage(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_unofficial_event_loop_checkpoint(
        env: SnapiEnv,
        mode: i32,
        has_runnable_work: i32,
        checkpoint_state: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_drain_pending_callbacks(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_drain_all_guest_finalizers(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_register_guest_buffer_finalizer(
        env: SnapiEnv,
        value_id: u32,
        guest_ptr: u32,
        recyclable: i32,
    ) -> i32;
    pub fn snapi_bridge_take_ready_guest_buffer_finalizer(
        env: SnapiEnv,
        force: i32,
        handle_id_out: *mut u32,
        guest_ptr_out: *mut u32,
        recyclable_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_set_prepare_stack_trace_callback(
        env: SnapiEnv,
        callback_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_cancel_terminate_execution(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_unofficial_request_interrupt(
        env: SnapiEnv,
        guest_env: u32,
        wasm_fn_ptr: u32,
        data: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_set_promise_hooks(
        env: SnapiEnv,
        init_callback_id: u32,
        before_callback_id: u32,
        after_callback_id: u32,
        resolve_callback_id: u32,
    ) -> i32;
    /// Register a host-owned near-heap-limit callback that charges V8 heap
    /// growth against the resource budget. `data` is an
    /// `*const crate::budget::EnvHeapCharge` passed opaquely to the callback.
    pub fn snapi_bridge_unofficial_set_host_near_heap_limit_callback(
        env: SnapiEnv,
        data: *const c_void,
    ) -> i32;
    /// Cap the number of live per-value host handles (and callback
    /// registrations) this env may hold, bounding host-side bookkeeping RSS.
    /// `limit == 0` means unlimited.
    pub fn snapi_bridge_unofficial_set_value_limit(env: SnapiEnv, limit: u64) -> i32;
    pub fn snapi_bridge_unofficial_get_promise_details(
        env: SnapiEnv,
        promise_id: u32,
        state_out: *mut i32,
        result_out: *mut u32,
        has_result_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_proxy_details(
        env: SnapiEnv,
        proxy_id: u32,
        target_out: *mut u32,
        handler_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_preview_entries(
        env: SnapiEnv,
        value_id: u32,
        entries_out: *mut u32,
        is_key_value_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_call_sites(
        env: SnapiEnv,
        frames: u32,
        callsites_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_arraybuffer_view_has_buffer(
        env: SnapiEnv,
        value_id: u32,
        result_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_constructor_name(
        env: SnapiEnv,
        value_id: u32,
        name_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_create_private_symbol(
        env: SnapiEnv,
        str_ptr: *const std::ffi::c_char,
        wasm_length: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_continuation_preserved_embedder_data(
        env: SnapiEnv,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_set_continuation_preserved_embedder_data(
        env: SnapiEnv,
        value_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_attach_env(
        env: SnapiEnv,
        fatal_callback_id: u32,
        oom_callback_id: u32,
        accepted_hooks_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_unofficial_terminate_execution(env: SnapiEnv) -> i32;
    /// iwci patch: see `snapi_bridge_host_terminate_execution` in
    /// napi_bridge_init.cc. Only for callers holding the env registry lock.
    pub fn snapi_bridge_host_terminate_execution(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_unofficial_enqueue_microtask(env: SnapiEnv, callback_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_set_promise_reject_callback(
        env: SnapiEnv,
        callback_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_own_non_index_properties(
        env: SnapiEnv,
        value_id: u32,
        filter_bits: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_hash_seed(env: SnapiEnv, hash_seed_out: *mut u64) -> i32;
    pub fn snapi_bridge_unofficial_get_error_metadata(
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
    ) -> i32;
    pub fn snapi_bridge_unofficial_configure_source_maps(
        env: SnapiEnv,
        enabled: i32,
        callback_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_preserve_error_source_message(
        env: SnapiEnv,
        error_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_mark_promise_as_handled(env: SnapiEnv, promise_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_get_heap_statistics(
        env: SnapiEnv,
        stats_out: *mut SnapiUnofficialHeapStatistics,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_heap_space_statistics(
        env: SnapiEnv,
        stats_out: *mut SnapiUnofficialHeapSpaceStatistics,
        capacity: u32,
        count_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_get_heap_code_statistics(
        env: SnapiEnv,
        stats_out: *mut SnapiUnofficialHeapCodeStatistics,
    ) -> i32;
    pub fn snapi_bridge_unofficial_profile_start(
        env: SnapiEnv,
        kind: i32,
        result_out: *mut i32,
        profile_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_profile_stop(
        env: SnapiEnv,
        profile: u32,
        json_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_take_heap_snapshot(
        env: SnapiEnv,
        expose_internals: i32,
        expose_numeric_values: i32,
        json_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_free_buffer(data: *mut c_void);
    pub fn snapi_bridge_unofficial_structured_clone(
        env: SnapiEnv,
        value_id: u32,
        transfer_list_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_message_create(
        env: SnapiEnv,
        value_id: u32,
        payload_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_message_take(
        env: SnapiEnv,
        payload: u32,
        value_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_message_drop(payload: u32);
    pub fn snapi_bridge_unofficial_notify_datetime_configuration_change(env: SnapiEnv) -> i32;
    pub fn snapi_bridge_unofficial_create_serdes_binding(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_unofficial_contextify_contains_module_syntax(
        env: SnapiEnv,
        code_id: u32,
        filename_id: u32,
        resource_name_id: u32,
        cjs_var_in_scope: i32,
        result_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_contextify_make_context(
        env: SnapiEnv,
        sandbox_or_symbol_id: u32,
        name_id: u32,
        origin_id: u32,
        allow_code_gen_strings: i32,
        allow_code_gen_wasm: i32,
        own_microtask_queue: i32,
        host_defined_option_id: u32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_contextify_run_script(
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
    ) -> i32;
    pub fn snapi_bridge_unofficial_contextify_compile_function(
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
    ) -> i32;
    pub fn snapi_bridge_unofficial_bytecode_open(
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
    ) -> i32;
    pub fn snapi_bridge_unofficial_bytecode_serialize(
        env: SnapiEnv,
        bytecode_id: u32,
        buffer_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_bytecode_release(env: SnapiEnv, bytecode_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_create(
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
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_destroy(env: SnapiEnv, handle_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_link(
        env: SnapiEnv,
        handle_id: u32,
        count: u32,
        linked_handle_ids: *const u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_instantiate(env: SnapiEnv, handle_id: u32) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_evaluate(
        env: SnapiEnv,
        handle_id: u32,
        timeout: i64,
        break_on_sigint: i32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_evaluate_sync(
        env: SnapiEnv,
        handle_id: u32,
        filename_id: u32,
        parent_filename_id: u32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_get_namespace(
        env: SnapiEnv,
        handle_id: u32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_get_state(
        env: SnapiEnv,
        handle_id: u32,
        status_out: *mut i32,
        error_out: *mut u32,
        has_async_graph_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_check_unsettled_top_level_await(
        env: SnapiEnv,
        handle_id: u32,
        warnings: i32,
        settled_out: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_set_export(
        env: SnapiEnv,
        handle_id: u32,
        export_name_id: u32,
        export_value_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_set_module_source_object(
        env: SnapiEnv,
        handle_id: u32,
        source_object_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_get_module_source_object(
        env: SnapiEnv,
        handle_id: u32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_create_cached_data(
        env: SnapiEnv,
        handle_id: u32,
        result_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_set_hooks(
        env: SnapiEnv,
        import_callback_id: u32,
        import_meta_callback_id: u32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_module_wrap_create_required_module_facade(
        env: SnapiEnv,
        handle_id: u32,
        result_out: *mut u32,
    ) -> i32;
    // Value creation
    pub fn snapi_bridge_get_undefined(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_null(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_boolean(env: SnapiEnv, value: i32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_global(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_string_utf8(
        env: SnapiEnv,
        str_ptr: *const std::ffi::c_char,
        wasm_length: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_string_latin1(
        env: SnapiEnv,
        str_ptr: *const std::ffi::c_char,
        wasm_length: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_int32(env: SnapiEnv, value: i32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_uint32(env: SnapiEnv, value: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_double(env: SnapiEnv, value: f64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_int64(env: SnapiEnv, value: i64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_object(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_array(env: SnapiEnv, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_array_with_length(
        env: SnapiEnv,
        length: u32,
        out_id: *mut u32,
    ) -> i32;
    // Value reading
    pub fn snapi_bridge_get_value_string_utf8(
        env: SnapiEnv,
        id: u32,
        buf: *mut std::ffi::c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> i32;
    pub fn snapi_bridge_get_value_string_latin1(
        env: SnapiEnv,
        id: u32,
        buf: *mut std::ffi::c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> i32;
    pub fn snapi_bridge_get_value_int32(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_get_value_uint32(env: SnapiEnv, id: u32, result: *mut u32) -> i32;
    pub fn snapi_bridge_get_value_double(env: SnapiEnv, id: u32, result: *mut f64) -> i32;
    pub fn snapi_bridge_get_value_int64(env: SnapiEnv, id: u32, result: *mut i64) -> i32;
    pub fn snapi_bridge_get_value_bool(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    // Type checking
    pub fn snapi_bridge_typeof(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_array(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_error(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_arraybuffer(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_typedarray(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_dataview(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_date(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_promise(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_instanceof(
        env: SnapiEnv,
        obj_id: u32,
        ctor_id: u32,
        result: *mut i32,
    ) -> i32;
    // Coercion
    pub fn snapi_bridge_coerce_to_bool(env: SnapiEnv, id: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_coerce_to_number(env: SnapiEnv, id: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_coerce_to_string(env: SnapiEnv, id: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_coerce_to_object(env: SnapiEnv, id: u32, out_id: *mut u32) -> i32;
    // Object operations
    pub fn snapi_bridge_set_property(env: SnapiEnv, obj_id: u32, key_id: u32, val_id: u32) -> i32;
    pub fn snapi_bridge_get_property(
        env: SnapiEnv,
        obj_id: u32,
        key_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_has_property(
        env: SnapiEnv,
        obj_id: u32,
        key_id: u32,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_has_own_property(
        env: SnapiEnv,
        obj_id: u32,
        key_id: u32,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_delete_property(
        env: SnapiEnv,
        obj_id: u32,
        key_id: u32,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_set_named_property(
        env: SnapiEnv,
        obj_id: u32,
        name: *const std::ffi::c_char,
        val_id: u32,
    ) -> i32;
    pub fn snapi_bridge_get_named_property(
        env: SnapiEnv,
        obj_id: u32,
        name: *const std::ffi::c_char,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_has_named_property(
        env: SnapiEnv,
        obj_id: u32,
        name: *const std::ffi::c_char,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_set_element(env: SnapiEnv, obj_id: u32, index: u32, val_id: u32) -> i32;
    pub fn snapi_bridge_get_element(
        env: SnapiEnv,
        obj_id: u32,
        index: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_has_element(
        env: SnapiEnv,
        obj_id: u32,
        index: u32,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_delete_element(
        env: SnapiEnv,
        obj_id: u32,
        index: u32,
        result: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_get_array_length(env: SnapiEnv, arr_id: u32, result: *mut u32) -> i32;
    pub fn snapi_bridge_get_property_names(env: SnapiEnv, obj_id: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_all_property_names(
        env: SnapiEnv,
        obj_id: u32,
        mode: i32,
        filter: i32,
        conversion: i32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_prototype(env: SnapiEnv, obj_id: u32, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_object_freeze(env: SnapiEnv, obj_id: u32) -> i32;
    pub fn snapi_bridge_object_seal(env: SnapiEnv, obj_id: u32) -> i32;
    // Comparison
    pub fn snapi_bridge_strict_equals(env: SnapiEnv, a_id: u32, b_id: u32, result: *mut i32)
    -> i32;
    // Error handling
    pub fn snapi_bridge_create_error(
        env: SnapiEnv,
        code_id: u32,
        msg_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_type_error(
        env: SnapiEnv,
        code_id: u32,
        msg_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_range_error(
        env: SnapiEnv,
        code_id: u32,
        msg_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_throw(env: SnapiEnv, error_id: u32) -> i32;
    pub fn snapi_bridge_throw_error(env: SnapiEnv, code: *const std::ffi::c_char, msg: *const std::ffi::c_char) -> i32;
    pub fn snapi_bridge_throw_type_error(env: SnapiEnv, code: *const std::ffi::c_char, msg: *const std::ffi::c_char) -> i32;
    pub fn snapi_bridge_throw_range_error(env: SnapiEnv, code: *const std::ffi::c_char, msg: *const std::ffi::c_char) -> i32;
    pub fn snapi_bridge_is_exception_pending(env: SnapiEnv, result: *mut i32) -> i32;
    pub fn snapi_bridge_get_and_clear_last_exception(env: SnapiEnv, out_id: *mut u32) -> i32;
    // Symbol
    pub fn snapi_bridge_create_symbol(env: SnapiEnv, description_id: u32, out_id: *mut u32) -> i32;
    // BigInt
    pub fn snapi_bridge_create_bigint_int64(env: SnapiEnv, value: i64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_create_bigint_uint64(env: SnapiEnv, value: u64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_value_bigint_int64(
        env: SnapiEnv,
        id: u32,
        value: *mut i64,
        lossless: *mut i32,
    ) -> i32;
    pub fn snapi_bridge_get_value_bigint_uint64(
        env: SnapiEnv,
        id: u32,
        value: *mut u64,
        lossless: *mut i32,
    ) -> i32;
    // Date
    pub fn snapi_bridge_create_date(env: SnapiEnv, time: f64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_date_value(env: SnapiEnv, id: u32, result: *mut f64) -> i32;
    // Promise
    pub fn snapi_bridge_create_promise(
        env: SnapiEnv,
        deferred_out: *mut u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_resolve_deferred(env: SnapiEnv, deferred_id: u32, value_id: u32) -> i32;
    pub fn snapi_bridge_reject_deferred(env: SnapiEnv, deferred_id: u32, value_id: u32) -> i32;
    // ArrayBuffer
    pub fn snapi_bridge_create_arraybuffer(
        env: SnapiEnv,
        byte_length: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_arraybuffer(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_buffer(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_arraybuffer_finalized(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        finalize_hint: *mut core::ffi::c_void,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_buffer_finalized(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        finalize_hint: *mut core::ffi::c_void,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_arraybuffer_guest_finalized(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        guest_env: u32,
        wasm_fn_ptr: u32,
        finalize_data: u32,
        finalize_hint: u32,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_external_buffer_guest_finalized(
        env: SnapiEnv,
        data_addr: u64,
        byte_length: u32,
        guest_env: u32,
        wasm_fn_ptr: u32,
        finalize_data: u32,
        finalize_hint: u32,
        backing_store_token_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_arraybuffer_info(
        env: SnapiEnv,
        id: u32,
        data_out: *mut u64,
        byte_length: *mut u32,
        backing_store_token_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_detach_arraybuffer(env: SnapiEnv, id: u32) -> i32;
    pub fn snapi_bridge_is_detached_arraybuffer(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_is_sharedarraybuffer(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_create_sharedarraybuffer(
        env: SnapiEnv,
        byte_length: u32,
        data_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_node_api_set_prototype(
        env: SnapiEnv,
        object_id: u32,
        prototype_id: u32,
    ) -> i32;
    // TypedArray
    pub fn snapi_bridge_create_typedarray(
        env: SnapiEnv,
        typ: i32,
        length: u32,
        arraybuffer_id: u32,
        byte_offset: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_typedarray_info(
        env: SnapiEnv,
        id: u32,
        type_out: *mut i32,
        length_out: *mut u32,
        data_out: *mut u64,
        arraybuffer_out: *mut u32,
        byte_offset_out: *mut u32,
        backing_store_token_out: *mut u64,
    ) -> i32;
    // DataView
    pub fn snapi_bridge_create_dataview(
        env: SnapiEnv,
        byte_length: u32,
        arraybuffer_id: u32,
        byte_offset: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_dataview_info(
        env: SnapiEnv,
        id: u32,
        byte_length_out: *mut u32,
        data_out: *mut u64,
        arraybuffer_out: *mut u32,
        byte_offset_out: *mut u32,
        backing_store_token_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_attach_guest_heap_finalizer(
        env: SnapiEnv,
        id: u32,
        finalize_hint: *mut c_void,
    ) -> i32;
    // External
    pub fn snapi_bridge_create_external(env: SnapiEnv, data_val: u64, out_id: *mut u32) -> i32;
    pub fn snapi_bridge_get_value_external(env: SnapiEnv, id: u32, data_out: *mut u64) -> i32;
    // References
    pub fn snapi_bridge_create_reference(
        env: SnapiEnv,
        value_id: u32,
        initial_refcount: u32,
        ref_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_delete_reference(env: SnapiEnv, ref_id: u32) -> i32;
    pub fn snapi_bridge_reference_ref(env: SnapiEnv, ref_id: u32, result: *mut u32) -> i32;
    pub fn snapi_bridge_reference_unref(env: SnapiEnv, ref_id: u32, result: *mut u32) -> i32;
    pub fn snapi_bridge_get_reference_value(env: SnapiEnv, ref_id: u32, out_id: *mut u32) -> i32;
    // Handle scopes
    pub fn snapi_bridge_open_handle_scope(env: SnapiEnv, scope_out: *mut u32) -> i32;
    pub fn snapi_bridge_close_handle_scope(env: SnapiEnv, scope_id: u32) -> i32;
    pub fn snapi_bridge_open_escapable_handle_scope(env: SnapiEnv, scope_out: *mut u32) -> i32;
    pub fn snapi_bridge_close_escapable_handle_scope(env: SnapiEnv, scope_id: u32) -> i32;
    pub fn snapi_bridge_escape_handle(
        env: SnapiEnv,
        scope_id: u32,
        escapee_id: u32,
        out_id: *mut u32,
    ) -> i32;
    // Type tagging
    pub fn snapi_bridge_type_tag_object(
        env: SnapiEnv,
        obj_id: u32,
        tag_lower: u64,
        tag_upper: u64,
    ) -> i32;
    pub fn snapi_bridge_check_object_type_tag(
        env: SnapiEnv,
        obj_id: u32,
        tag_lower: u64,
        tag_upper: u64,
        result: *mut i32,
    ) -> i32;
    // Function calling
    pub fn snapi_bridge_call_function(
        env: SnapiEnv,
        recv_id: u32,
        func_id: u32,
        argc: u32,
        argv_ids: *const u32,
        out_id: *mut u32,
    ) -> i32;
    // Script execution
    pub fn snapi_bridge_run_script(env: SnapiEnv, script_id: u32, out_value_id: *mut u32) -> i32;
    // UTF-16 strings
    pub fn snapi_bridge_create_string_utf16(
        env: SnapiEnv,
        str_ptr: *const u16,
        wasm_length: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_value_string_utf16(
        env: SnapiEnv,
        id: u32,
        buf: *mut u16,
        bufsize: usize,
        result: *mut usize,
    ) -> i32;
    // BigInt words
    pub fn snapi_bridge_create_bigint_words(
        env: SnapiEnv,
        sign_bit: i32,
        word_count: u32,
        words: *const u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_value_bigint_words(
        env: SnapiEnv,
        id: u32,
        sign_bit: *mut i32,
        word_count: *mut usize,
        words: *mut u64,
    ) -> i32;
    // Instance data
    pub fn snapi_bridge_set_instance_data(env: SnapiEnv, data_val: u64) -> i32;
    pub fn snapi_bridge_get_instance_data(env: SnapiEnv, data_out: *mut u64) -> i32;
    pub fn snapi_bridge_adjust_external_memory(
        env: SnapiEnv,
        change: i64,
        adjusted: *mut i64,
    ) -> i32;
    // Node Buffers
    pub fn snapi_bridge_create_buffer(
        env: SnapiEnv,
        length: u32,
        data_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_create_buffer_copy(
        env: SnapiEnv,
        length: u32,
        src_data: *const u8,
        result_data_out: *mut u64,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_is_buffer(env: SnapiEnv, id: u32, result: *mut i32) -> i32;
    pub fn snapi_bridge_get_buffer_info(
        env: SnapiEnv,
        id: u32,
        data_out: *mut u64,
        length_out: *mut u32,
        backing_store_token_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_unofficial_acquire_buffer_lease(
        env: SnapiEnv,
        value_id: u32,
        byte_offset: u32,
        byte_length: u32,
        mode: i32,
        lease_out: *mut u32,
        data_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_unofficial_release_buffer_lease(
        env: SnapiEnv,
        lease_id: u32,
        modified: i32,
    ) -> i32;
    pub fn snapi_bridge_unofficial_create_guest_backed_typedarray(
        env: SnapiEnv,
        type_: i32,
        length: u32,
        data_out: *mut u64,
        value_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_get_backing_store_token(env: SnapiEnv, id: u32, token_out: *mut u64)
    -> i32;
    pub fn snapi_bridge_overwrite_value_bytes(
        env: SnapiEnv,
        id: u32,
        data: *const core::ffi::c_void,
        len: u32,
    ) -> i32;
    pub fn snapi_bridge_overwrite_reference_bytes(
        env: SnapiEnv,
        reference_id: u32,
        data: *const core::ffi::c_void,
        len: u32,
    ) -> i32;
    // Node version
    pub fn snapi_bridge_get_node_version(
        env: SnapiEnv,
        major: *mut u32,
        minor: *mut u32,
        patch: *mut u32,
    ) -> i32;
    // Object wrapping
    pub fn snapi_bridge_wrap(
        env: SnapiEnv,
        obj_id: u32,
        native_data: u64,
        ref_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_unwrap(env: SnapiEnv, obj_id: u32, data_out: *mut u64) -> i32;
    pub fn snapi_bridge_remove_wrap(env: SnapiEnv, obj_id: u32, data_out: *mut u64) -> i32;
    pub fn snapi_bridge_add_finalizer(
        env: SnapiEnv,
        obj_id: u32,
        data_val: u64,
        ref_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_wrap_finalized(
        env: SnapiEnv,
        obj_id: u32,
        native_data: u64,
        guest_env: u32,
        wasm_fn_ptr: u32,
        finalize_data: u32,
        finalize_hint: u32,
        ref_out: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_add_finalizer_cb(
        env: SnapiEnv,
        obj_id: u32,
        data_val: u64,
        guest_env: u32,
        wasm_fn_ptr: u32,
        finalize_data: u32,
        finalize_hint: u32,
        ref_out: *mut u32,
    ) -> i32;
    // Constructor
    pub fn snapi_bridge_new_instance(
        env: SnapiEnv,
        ctor_id: u32,
        argc: u32,
        argv_ids: *const u32,
        out_id: *mut u32,
    ) -> i32;
    // Callback system
    pub fn snapi_bridge_create_function(
        env: SnapiEnv,
        utf8name: *const std::ffi::c_char,
        name_len: u32,
        reg_id: u32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_swap_active_callback_ctx(
        env: SnapiEnv,
        callback_ctx: *mut c_void,
    ) -> *mut c_void;
    pub fn snapi_bridge_alloc_cb_reg_id(env: SnapiEnv) -> u32;
    pub fn snapi_bridge_register_callback(
        env: SnapiEnv,
        reg_id: u32,
        guest_env: u32,
        wasm_fn_ptr: u32,
        data_val: u64,
    );
    pub fn snapi_bridge_register_callback_pair(
        env: SnapiEnv,
        reg_id: u32,
        guest_env: u32,
        wasm_getter_fn_ptr: u32,
        wasm_setter_fn_ptr: u32,
        data_val: u64,
    );
    pub fn snapi_bridge_get_cb_info(
        env: SnapiEnv,
        cbinfo_id: u32,
        argc_ptr: *mut u32,
        argv_out: *mut u32,
        max_argv: u32,
        this_out: *mut u32,
        data_out: *mut u64,
    ) -> i32;
    pub fn snapi_bridge_get_new_target(env: SnapiEnv, cbinfo_id: u32, out_id: *mut u32) -> i32;
    // napi_define_class
    pub fn snapi_bridge_define_class(
        env: SnapiEnv,
        utf8name: *const std::ffi::c_char,
        name_len: u32,
        ctor_reg_id: u32,
        prop_count: u32,
        prop_names: *const *const std::ffi::c_char,
        prop_name_ids: *const u32,
        prop_types: *const u32,
        prop_value_ids: *const u32,
        prop_method_reg_ids: *const u32,
        prop_getter_reg_ids: *const u32,
        prop_setter_reg_ids: *const u32,
        prop_attributes: *const i32,
        out_id: *mut u32,
    ) -> i32;
    pub fn snapi_bridge_define_properties(
        env: SnapiEnv,
        obj_id: u32,
        prop_count: u32,
        prop_names: *const *const std::ffi::c_char,
        prop_name_ids: *const u32,
        prop_types: *const u32,
        prop_value_ids: *const u32,
        prop_method_reg_ids: *const u32,
        prop_getter_reg_ids: *const u32,
        prop_setter_reg_ids: *const u32,
        prop_attributes: *const i32,
    ) -> i32;
    // Cleanup
    #[allow(dead_code)]
    pub fn snapi_bridge_dispose();
}
