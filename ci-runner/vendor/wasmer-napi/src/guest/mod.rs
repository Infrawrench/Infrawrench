pub(crate) mod abi;
#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
pub mod callback;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
#[path = "callback_js.rs"]
pub mod callback;
#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
pub mod napi;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
#[path = "napi_js.rs"]
pub mod napi;
#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
pub mod util;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
#[path = "util_js.rs"]
pub mod util;

pub const MAX_GUEST_CSTRING_SCAN: usize = 64 * 1024;

/// Hard ceilings on host scratch buffers sized by a guest-supplied *count*
/// (rather than by data that lives in guest memory). These are rejected before
/// allocating — mirroring the WASIX `MAX_SOCKET_PAYLOAD` write cap — so a bogus
/// count can never allocate gigabytes host-side. Each is ~256 KiB worth, far
/// beyond any legitimate use (no function has 65k args; no real BigInt is a
/// 2-Mbit integer), which keeps the transient uncounted host memory negligible.
pub const MAX_NAPI_CALLBACK_ARGS: usize = 64 * 1024;
pub const MAX_NAPI_BIGINT_WORDS: usize = 32 * 1024;

/// Byte width for the public `napi_typedarray_type` enum. Keep the mapping in
/// one place for both guest backends; values outside the public enum are not
/// alternate engine-specific typed-array kinds.
pub const fn typedarray_element_size(typ: i32) -> Option<usize> {
    match typ {
        0..=2 => Some(1),
        3 | 4 | 11 => Some(2),
        5..=7 => Some(4),
        8..=10 => Some(8),
        _ => None,
    }
}

/// Maximum depth of nested guest↔host callback crossings on one thread. Each
/// crossing piles host native stack frames (Rust bridge + C++ V8) that neither
/// the wasm nor the V8 stack limit bounds, so unbounded reentrancy would SIGSEGV
/// the process uncatchably. Far beyond any legitimate synchronous nesting.
pub const MAX_CALLBACK_DEPTH: u32 = 256;
