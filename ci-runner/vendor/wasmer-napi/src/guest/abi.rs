use wasmer::FunctionEnvMut;

use crate::NapiEnv;

use super::util::read_guest_bytes;

#[repr(C)]
struct Wasm32VersionedHeader {
    size: u32,
    version: u32,
}

#[repr(C)]
struct Wasm32RuntimeOptionsV1 {
    size: u32,
    version: u32,
    engine_flags: u32,
    engine_flags_length: u32,
}

#[repr(C)]
struct Wasm32EnvCreateOptionsV1 {
    size: u32,
    version: u32,
    total_memory: u64,
    constrained_memory: u64,
    max_young_generation_size_in_bytes: u32,
    max_old_generation_size_in_bytes: u32,
    code_range_size_in_bytes: u32,
    stack_limit: u32,
    guest_heap: u32,
}

#[repr(C)]
struct Wasm32EnvHooksV1 {
    size: u32,
    version: u32,
    data: u32,
    context_token_assign_callback: u32,
    context_token_unassign_callback: u32,
    enqueue_foreground_task_callback: u32,
    fatal_error_callback: u32,
    oom_error_callback: u32,
}

#[repr(C)]
struct Wasm32JsSource {
    kind: i32,
    text: u32,
    bytecode: u32,
}

#[repr(C)]
struct Wasm32BytecodeOpenOptionsV1 {
    size: u32,
    version: u32,
    source_text: u32,
    filename: u32,
    shape: i32,
    params_or_undefined: u32,
    host_defined_option_id: u32,
    line_offset: i32,
    column_offset: i32,
    cache_bytes: u32,
    cache_byte_length: u32,
    has_cache: u8,
    cache_policy: u8,
    reserved: [u8; 2],
}

#[repr(C)]
struct Wasm32ModuleCreateOptionsV1 {
    size: u32,
    version: u32,
    kind: i32,
    wrapper: u32,
    url: u32,
    context_or_undefined: u32,
    payload: [u8; 16],
}

#[repr(C)]
struct Wasm32ModuleCreateJsPayload {
    source: u32,
    line_offset: i32,
    column_offset: i32,
    host_defined_option_id: u32,
}

#[repr(C)]
struct Wasm32ModuleCreateSyntheticPayload {
    export_names: u32,
    synthetic_eval_steps: u32,
    reserved: [u8; 8],
}

#[repr(C)]
struct Wasm32ModuleHooksV1 {
    size: u32,
    version: u32,
    import_module_dynamically: u32,
    initialize_import_meta_object: u32,
}

const JS_SOURCE_SIZE: usize = std::mem::size_of::<Wasm32JsSource>();
const RUNTIME_OPTIONS_SIZE: usize = std::mem::size_of::<Wasm32RuntimeOptionsV1>();
const ENV_CREATE_PREFIX_SIZE: usize = std::mem::size_of::<Wasm32EnvCreateOptionsV1>();
const BYTECODE_OPEN_SIZE: usize = std::mem::size_of::<Wasm32BytecodeOpenOptionsV1>();
const MODULE_CREATE_PREFIX_SIZE: usize = std::mem::size_of::<Wasm32ModuleCreateOptionsV1>();
const MODULE_HOOKS_SIZE: usize = std::mem::size_of::<Wasm32ModuleHooksV1>();
const ENV_HOOKS_SIZE: usize = std::mem::size_of::<Wasm32EnvHooksV1>();

const _: () = assert!(std::mem::size_of::<Wasm32VersionedHeader>() == 8);
const _: () = assert!(JS_SOURCE_SIZE == 12);
const _: () = assert!(RUNTIME_OPTIONS_SIZE == 16);
const _: () = assert!(ENV_CREATE_PREFIX_SIZE == 48);
const _: () = assert!(BYTECODE_OPEN_SIZE == 48);
const _: () = assert!(MODULE_CREATE_PREFIX_SIZE == 40);
const _: () = assert!(std::mem::size_of::<Wasm32ModuleCreateJsPayload>() == 16);
const _: () = assert!(std::mem::size_of::<Wasm32ModuleCreateSyntheticPayload>() == 16);
const _: () = assert!(MODULE_HOOKS_SIZE == 16);
const _: () = assert!(ENV_HOOKS_SIZE == 32);

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn i32_at(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_versioned(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    prefix_size: usize,
    version: u32,
) -> Option<Vec<u8>> {
    if guest_ptr <= 0 {
        return None;
    }
    let bytes = read_guest_bytes(env, guest_ptr, prefix_size)?;
    if u32_at(&bytes, std::mem::offset_of!(Wasm32VersionedHeader, size))? < prefix_size as u32
        || u32_at(&bytes, std::mem::offset_of!(Wasm32VersionedHeader, version))? != version
    {
        return None;
    }
    Some(bytes)
}

pub(crate) fn read_output_header(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    minimum_size: usize,
    version: u32,
) -> Option<u32> {
    let bytes = read_guest_bytes(env, guest_ptr, 8)?;
    let size = u32_at(&bytes, std::mem::offset_of!(Wasm32VersionedHeader, size))?;
    (size >= minimum_size as u32
        && u32_at(&bytes, std::mem::offset_of!(Wasm32VersionedHeader, version))? == version)
        .then_some(size)
}

pub(crate) struct EnvCreate {
    pub total_memory: u64,
    pub constrained_memory: u64,
    pub max_young_generation_size_in_bytes: u32,
    pub max_old_generation_size_in_bytes: u32,
    pub code_range_size_in_bytes: u32,
    pub stack_limit: u32,
}

pub(crate) fn read_runtime_options(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<Vec<u8>> {
    if guest_ptr == 0 {
        return Some(Vec::new());
    }
    let bytes = read_versioned(env, guest_ptr, RUNTIME_OPTIONS_SIZE, 1)?;
    let flags_ptr = u32_at(
        &bytes,
        std::mem::offset_of!(Wasm32RuntimeOptionsV1, engine_flags),
    )? as i32;
    let flags_length = u32_at(
        &bytes,
        std::mem::offset_of!(Wasm32RuntimeOptionsV1, engine_flags_length),
    )? as usize;
    if flags_length == 0 {
        return Some(Vec::new());
    }
    if flags_ptr <= 0 {
        return None;
    }
    read_guest_bytes(env, flags_ptr, flags_length)
}

pub(crate) fn read_env_create(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<EnvCreate> {
    let bytes = read_versioned(env, guest_ptr, ENV_CREATE_PREFIX_SIZE, 1)?;
    // A raw guest pointer is not an unofficial_napi_guest_heap provider
    // resource. Wasmer injects its own guest-heap owner after decoding, so a
    // non-null wire field is rejected rather than silently discarded.
    if u32_at(
        &bytes,
        std::mem::offset_of!(Wasm32EnvCreateOptionsV1, guest_heap),
    )? != 0
    {
        return None;
    }
    Some(EnvCreate {
        total_memory: u64::from_le_bytes(
            bytes
                .get(
                    std::mem::offset_of!(Wasm32EnvCreateOptionsV1, total_memory)
                        ..std::mem::offset_of!(Wasm32EnvCreateOptionsV1, total_memory) + 8,
                )?
                .try_into()
                .ok()?,
        ),
        constrained_memory: u64::from_le_bytes(
            bytes
                .get(
                    std::mem::offset_of!(Wasm32EnvCreateOptionsV1, constrained_memory)
                        ..std::mem::offset_of!(Wasm32EnvCreateOptionsV1, constrained_memory) + 8,
                )?
                .try_into()
                .ok()?,
        ),
        max_young_generation_size_in_bytes: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvCreateOptionsV1, max_young_generation_size_in_bytes),
        )?,
        max_old_generation_size_in_bytes: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvCreateOptionsV1, max_old_generation_size_in_bytes),
        )?,
        code_range_size_in_bytes: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvCreateOptionsV1, code_range_size_in_bytes),
        )?,
        stack_limit: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvCreateOptionsV1, stack_limit),
        )?,
    })
}

pub(crate) fn read_js_source(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<(u32, u32)> {
    let bytes = read_guest_bytes(env, guest_ptr, JS_SOURCE_SIZE)?;
    match (
        i32_at(&bytes, std::mem::offset_of!(Wasm32JsSource, kind))?,
        u32_at(&bytes, std::mem::offset_of!(Wasm32JsSource, text))?,
        u32_at(&bytes, std::mem::offset_of!(Wasm32JsSource, bytecode))?,
    ) {
        (0, text, 0) if text != 0 => Some((text, 0)),
        (1, 0, bytecode) if bytecode != 0 => Some((0, bytecode)),
        _ => None,
    }
}

pub(crate) struct BytecodeOpen {
    pub source_text: u32,
    pub filename: u32,
    pub shape: i32,
    pub params_or_undefined: u32,
    pub host_defined_option_id: u32,
    pub line_offset: i32,
    pub column_offset: i32,
    pub cache: Vec<u8>,
    pub has_cache: u8,
    pub cache_policy: u8,
}

pub(crate) fn read_bytecode_open(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<BytecodeOpen> {
    let bytes = read_versioned(env, guest_ptr, BYTECODE_OPEN_SIZE, 1)?;
    let cache_ptr = u32_at(
        &bytes,
        std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, cache_bytes),
    )? as i32;
    let cache_length = u32_at(
        &bytes,
        std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, cache_byte_length),
    )? as usize;
    let has_cache = *bytes.get(std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, has_cache))?;
    let cache_policy = *bytes.get(std::mem::offset_of!(
        Wasm32BytecodeOpenOptionsV1,
        cache_policy
    ))?;
    let cache = if has_cache != 0 && cache_length != 0 {
        if cache_ptr <= 0 {
            return None;
        }
        read_guest_bytes(env, cache_ptr, cache_length)?
    } else {
        Vec::new()
    };
    Some(BytecodeOpen {
        source_text: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, source_text),
        )?,
        filename: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, filename),
        )?,
        shape: i32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, shape),
        )?,
        params_or_undefined: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, params_or_undefined),
        )?,
        host_defined_option_id: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, host_defined_option_id),
        )?,
        line_offset: i32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, line_offset),
        )?,
        column_offset: i32_at(
            &bytes,
            std::mem::offset_of!(Wasm32BytecodeOpenOptionsV1, column_offset),
        )?,
        cache,
        has_cache,
        cache_policy,
    })
}

pub(crate) struct ModuleCreate {
    pub kind: i32,
    pub wrapper: u32,
    pub url: u32,
    pub context_or_undefined: u32,
    pub source_text: u32,
    pub source_bytecode: u32,
    pub line_offset: i32,
    pub column_offset: i32,
    pub host_defined_option_id: u32,
    pub export_names: u32,
    pub synthetic_eval_steps: u32,
}

pub(crate) fn read_module_create(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<ModuleCreate> {
    let bytes = read_versioned(env, guest_ptr, MODULE_CREATE_PREFIX_SIZE, 1)?;
    let kind = i32_at(
        &bytes,
        std::mem::offset_of!(Wasm32ModuleCreateOptionsV1, kind),
    )?;
    let payload_offset = std::mem::offset_of!(Wasm32ModuleCreateOptionsV1, payload);
    let (
        source_text,
        source_bytecode,
        line_offset,
        column_offset,
        host_defined_option_id,
        export_names,
        synthetic_eval_steps,
    ) = match kind {
        1 => {
            let source_offset =
                payload_offset + std::mem::offset_of!(Wasm32ModuleCreateJsPayload, source);
            let (text, bytecode) = read_js_source(env, u32_at(&bytes, source_offset)? as i32)?;
            (
                text,
                bytecode,
                i32_at(
                    &bytes,
                    payload_offset + std::mem::offset_of!(Wasm32ModuleCreateJsPayload, line_offset),
                )?,
                i32_at(
                    &bytes,
                    payload_offset
                        + std::mem::offset_of!(Wasm32ModuleCreateJsPayload, column_offset),
                )?,
                u32_at(
                    &bytes,
                    payload_offset
                        + std::mem::offset_of!(Wasm32ModuleCreateJsPayload, host_defined_option_id),
                )?,
                0,
                0,
            )
        }
        2 => (
            0,
            0,
            0,
            0,
            0,
            u32_at(
                &bytes,
                payload_offset
                    + std::mem::offset_of!(Wasm32ModuleCreateSyntheticPayload, export_names),
            )?,
            u32_at(
                &bytes,
                payload_offset
                    + std::mem::offset_of!(
                        Wasm32ModuleCreateSyntheticPayload,
                        synthetic_eval_steps
                    ),
            )?,
        ),
        _ => return None,
    };
    Some(ModuleCreate {
        kind,
        wrapper: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32ModuleCreateOptionsV1, wrapper),
        )?,
        url: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32ModuleCreateOptionsV1, url),
        )?,
        context_or_undefined: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32ModuleCreateOptionsV1, context_or_undefined),
        )?,
        source_text,
        source_bytecode,
        line_offset,
        column_offset,
        host_defined_option_id,
        export_names,
        synthetic_eval_steps,
    })
}

pub(crate) fn read_module_hooks(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<(u32, u32)> {
    let bytes = read_versioned(env, guest_ptr, MODULE_HOOKS_SIZE, 1)?;
    Some((
        u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32ModuleHooksV1, import_module_dynamically),
        )?,
        u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32ModuleHooksV1, initialize_import_meta_object),
        )?,
    ))
}

pub(crate) struct EnvHooks {
    pub fatal: u32,
    pub oom: u32,
    pub requested: u64,
}

pub(crate) fn read_env_hooks(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
) -> Option<EnvHooks> {
    let bytes = read_versioned(env, guest_ptr, ENV_HOOKS_SIZE, 1)?;
    let hook_fields = [
        (
            Wasm32EnvHooksV1::context_token_assign_callback_offset(),
            1u64 << 0,
        ),
        (
            Wasm32EnvHooksV1::context_token_unassign_callback_offset(),
            1u64 << 1,
        ),
        (
            Wasm32EnvHooksV1::enqueue_foreground_task_callback_offset(),
            1u64 << 2,
        ),
        (Wasm32EnvHooksV1::fatal_error_callback_offset(), 1u64 << 3),
        (Wasm32EnvHooksV1::oom_error_callback_offset(), 1u64 << 4),
    ];
    let mut requested = 0;
    for (offset, bit) in hook_fields {
        if u32_at(&bytes, offset)? != 0 {
            requested |= bit;
        }
    }
    Some(EnvHooks {
        fatal: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvHooksV1, fatal_error_callback),
        )?,
        oom: u32_at(
            &bytes,
            std::mem::offset_of!(Wasm32EnvHooksV1, oom_error_callback),
        )?,
        requested,
    })
}

impl Wasm32EnvHooksV1 {
    const fn context_token_assign_callback_offset() -> usize {
        std::mem::offset_of!(Self, context_token_assign_callback)
    }
    const fn context_token_unassign_callback_offset() -> usize {
        std::mem::offset_of!(Self, context_token_unassign_callback)
    }
    const fn enqueue_foreground_task_callback_offset() -> usize {
        std::mem::offset_of!(Self, enqueue_foreground_task_callback)
    }
    const fn fatal_error_callback_offset() -> usize {
        std::mem::offset_of!(Self, fatal_error_callback)
    }
    const fn oom_error_callback_offset() -> usize {
        std::mem::offset_of!(Self, oom_error_callback)
    }
}
