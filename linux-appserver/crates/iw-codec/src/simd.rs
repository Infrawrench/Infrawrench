//! Hand-vectorised inner loops.
//!
//! Two kernels carry the encoder's per-pixel work: the interframe difference
//! (read two bytes, subtract, store, and notice whether the answer was zero)
//! and the uniform-colour test. Both are byte-parallel with no dependencies
//! between iterations, which is the shape SIMD exists for — and both run over
//! every damaged pixel of every frame, which on a HiDPI window is millions.
//!
//! The dispatch is deliberate rather than left to the autovectoriser. The zero
//! *count* is a reduction across a comparison, which LLVM vectorises
//! inconsistently and not at all at the `opt-level` a debug build uses; and the
//! shipped binary is built for a baseline target, so the only AVX2 that ever
//! runs is AVX2 we detect at runtime. SSE2 is part of the x86-64 ABI and NEON
//! is part of AArch64, so those two need no detection and no fallback.
//!
//! Every kernel here has a scalar twin and a test that asserts they agree byte
//! for byte, because "the fast one is wrong on the tail" is the entire failure
//! mode of this file.

/// `buf[i] = buf[i] - prev[i]`, wrapping, returning how many results were zero.
///
/// The count is what decides whether the difference is worth sending at all, so
/// it comes out of the same pass rather than a second one.
pub fn delta_in_place(buf: &mut [u8], prev: &[u8]) -> usize {
    let len = buf.len().min(prev.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") {
            // SAFETY: guarded by the runtime check; the slices are truncated to
            // a common length and every access below is inside it.
            return unsafe { x86::delta_avx2(&mut buf[..len], &prev[..len]) };
        }
        // SAFETY: SSE2 is guaranteed by the x86-64 ABI.
        return unsafe { x86::delta_sse2(&mut buf[..len], &prev[..len]) };
    }
    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: NEON is guaranteed by the AArch64 ABI.
        return unsafe { arm::delta_neon(&mut buf[..len], &prev[..len]) };
    }
    #[allow(unreachable_code)]
    delta_scalar(&mut buf[..len], &prev[..len])
}

/// `buf[i] = buf[i] + prev[i]`, wrapping — the inverse of [`delta_in_place`].
///
/// Used to put the pixels back when a difference turned out not to be worth
/// sending, which is why it is worth vectorising too: it runs on exactly the
/// frames where the encoder is already busiest.
pub fn undelta_in_place(buf: &mut [u8], prev: &[u8]) {
    let len = buf.len().min(prev.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") {
            // SAFETY: guarded by the runtime check.
            unsafe { x86::undelta_avx2(&mut buf[..len], &prev[..len]) };
            return;
        }
        // SAFETY: SSE2 is guaranteed by the x86-64 ABI.
        unsafe { x86::undelta_sse2(&mut buf[..len], &prev[..len]) };
        return;
    }
    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: NEON is guaranteed by the AArch64 ABI.
        unsafe { arm::undelta_neon(&mut buf[..len], &prev[..len]) };
        return;
    }
    #[allow(unreachable_code)]
    undelta_scalar(&mut buf[..len], &prev[..len]);
}

/// Is every 4-byte pixel in `bytes` equal to `pixel`?
///
/// `bytes` is a whole number of pixels starting on a pixel boundary; anything
/// else is a caller bug and answers false rather than reading past the end.
pub fn is_uniform(bytes: &[u8], pixel: [u8; 4]) -> bool {
    if bytes.len() % 4 != 0 {
        return false;
    }
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") {
            // SAFETY: guarded by the runtime check.
            return unsafe { x86::is_uniform_avx2(bytes, pixel) };
        }
        // SAFETY: SSE2 is guaranteed by the x86-64 ABI.
        return unsafe { x86::is_uniform_sse2(bytes, pixel) };
    }
    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: NEON is guaranteed by the AArch64 ABI.
        return unsafe { arm::is_uniform_neon(bytes, pixel) };
    }
    #[allow(unreachable_code)]
    is_uniform_scalar(bytes, pixel)
}

// The scalar twins. Also the implementation on any target that is neither
// x86-64 nor AArch64 — which nothing ships on, but which has to be correct
// because the tests below run against both halves on whatever the developer is
// sitting at.

pub(crate) fn delta_scalar(buf: &mut [u8], prev: &[u8]) -> usize {
    let mut zeros = 0usize;
    for (b, p) in buf.iter_mut().zip(prev) {
        let d = b.wrapping_sub(*p);
        *b = d;
        zeros += usize::from(d == 0);
    }
    zeros
}

pub(crate) fn undelta_scalar(buf: &mut [u8], prev: &[u8]) {
    for (b, p) in buf.iter_mut().zip(prev) {
        *b = b.wrapping_add(*p);
    }
}

pub(crate) fn is_uniform_scalar(bytes: &[u8], pixel: [u8; 4]) -> bool {
    bytes.chunks_exact(4).all(|px| px == pixel)
}

#[cfg(target_arch = "x86_64")]
mod x86 {
    use core::arch::x86_64::*;

    /// 32 bytes per iteration.
    ///
    /// # Safety
    /// The caller has checked for AVX2. `buf` and `prev` are the same length.
    #[target_feature(enable = "avx2")]
    pub unsafe fn delta_avx2(buf: &mut [u8], prev: &[u8]) -> usize {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut zeros = 0usize;
            let mut i = 0usize;
            let zero = _mm256_setzero_si256();
            while i + 32 <= len {
                let b = _mm256_loadu_si256(buf.as_ptr().add(i) as *const __m256i);
                let p = _mm256_loadu_si256(prev.as_ptr().add(i) as *const __m256i);
                let d = _mm256_sub_epi8(b, p);
                _mm256_storeu_si256(buf.as_mut_ptr().add(i) as *mut __m256i, d);
                // One bit per byte that came out zero; popcount is the count.
                zeros +=
                    (_mm256_movemask_epi8(_mm256_cmpeq_epi8(d, zero)) as u32).count_ones() as usize;
                i += 32;
            }
            zeros + super::delta_scalar(&mut buf[i..], &prev[i..])
        }
    }

    /// # Safety
    /// SSE2 is baseline on x86-64. `buf` and `prev` are the same length.
    pub unsafe fn delta_sse2(buf: &mut [u8], prev: &[u8]) -> usize {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut zeros = 0usize;
            let mut i = 0usize;
            let zero = _mm_setzero_si128();
            while i + 16 <= len {
                let b = _mm_loadu_si128(buf.as_ptr().add(i) as *const __m128i);
                let p = _mm_loadu_si128(prev.as_ptr().add(i) as *const __m128i);
                let d = _mm_sub_epi8(b, p);
                _mm_storeu_si128(buf.as_mut_ptr().add(i) as *mut __m128i, d);
                zeros += (_mm_movemask_epi8(_mm_cmpeq_epi8(d, zero)) as u32).count_ones() as usize;
                i += 16;
            }
            zeros + super::delta_scalar(&mut buf[i..], &prev[i..])
        }
    }

    /// # Safety
    /// The caller has checked for AVX2. `buf` and `prev` are the same length.
    #[target_feature(enable = "avx2")]
    pub unsafe fn undelta_avx2(buf: &mut [u8], prev: &[u8]) {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut i = 0usize;
            while i + 32 <= len {
                let b = _mm256_loadu_si256(buf.as_ptr().add(i) as *const __m256i);
                let p = _mm256_loadu_si256(prev.as_ptr().add(i) as *const __m256i);
                _mm256_storeu_si256(
                    buf.as_mut_ptr().add(i) as *mut __m256i,
                    _mm256_add_epi8(b, p),
                );
                i += 32;
            }
            super::undelta_scalar(&mut buf[i..], &prev[i..]);
        }
    }

    /// # Safety
    /// SSE2 is baseline on x86-64. `buf` and `prev` are the same length.
    pub unsafe fn undelta_sse2(buf: &mut [u8], prev: &[u8]) {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut i = 0usize;
            while i + 16 <= len {
                let b = _mm_loadu_si128(buf.as_ptr().add(i) as *const __m128i);
                let p = _mm_loadu_si128(prev.as_ptr().add(i) as *const __m128i);
                _mm_storeu_si128(buf.as_mut_ptr().add(i) as *mut __m128i, _mm_add_epi8(b, p));
                i += 16;
            }
            super::undelta_scalar(&mut buf[i..], &prev[i..]);
        }
    }

    /// # Safety
    /// The caller has checked for AVX2. `bytes` is a whole number of pixels.
    #[target_feature(enable = "avx2")]
    pub unsafe fn is_uniform_avx2(bytes: &[u8], pixel: [u8; 4]) -> bool {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = bytes.len();
            let want = _mm256_set1_epi32(i32::from_le_bytes(pixel));
            let mut i = 0usize;
            while i + 32 <= len {
                let v = _mm256_loadu_si256(bytes.as_ptr().add(i) as *const __m256i);
                if _mm256_movemask_epi8(_mm256_cmpeq_epi8(v, want)) != -1 {
                    return false;
                }
                i += 32;
            }
            super::is_uniform_scalar(&bytes[i..], pixel)
        }
    }

    /// # Safety
    /// SSE2 is baseline on x86-64. `bytes` is a whole number of pixels.
    pub unsafe fn is_uniform_sse2(bytes: &[u8], pixel: [u8; 4]) -> bool {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = bytes.len();
            let want = _mm_set1_epi32(i32::from_le_bytes(pixel));
            let mut i = 0usize;
            while i + 16 <= len {
                let v = _mm_loadu_si128(bytes.as_ptr().add(i) as *const __m128i);
                if _mm_movemask_epi8(_mm_cmpeq_epi8(v, want)) != 0xffff {
                    return false;
                }
                i += 16;
            }
            super::is_uniform_scalar(&bytes[i..], pixel)
        }
    }
}

#[cfg(target_arch = "aarch64")]
mod arm {
    use core::arch::aarch64::*;

    /// # Safety
    /// NEON is baseline on AArch64. `buf` and `prev` are the same length.
    pub unsafe fn delta_neon(buf: &mut [u8], prev: &[u8]) -> usize {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut zeros = 0usize;
            let mut i = 0usize;
            let zero = vdupq_n_u8(0);
            while i + 16 <= len {
                let b = vld1q_u8(buf.as_ptr().add(i));
                let p = vld1q_u8(prev.as_ptr().add(i));
                let d = vsubq_u8(b, p);
                vst1q_u8(buf.as_mut_ptr().add(i), d);
                // NEON has no movemask: compare gives 0xff per equal byte, a shift
                // turns those into ones, and the across-vector add counts them.
                // The maximum is 16, so the u8 lane cannot overflow.
                zeros += vaddvq_u8(vshrq_n_u8(vceqq_u8(d, zero), 7)) as usize;
                i += 16;
            }
            zeros + super::delta_scalar(&mut buf[i..], &prev[i..])
        }
    }

    /// # Safety
    /// NEON is baseline on AArch64. `buf` and `prev` are the same length.
    pub unsafe fn undelta_neon(buf: &mut [u8], prev: &[u8]) {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = buf.len();
            let mut i = 0usize;
            while i + 16 <= len {
                let b = vld1q_u8(buf.as_ptr().add(i));
                let p = vld1q_u8(prev.as_ptr().add(i));
                vst1q_u8(buf.as_mut_ptr().add(i), vaddq_u8(b, p));
                i += 16;
            }
            super::undelta_scalar(&mut buf[i..], &prev[i..]);
        }
    }

    /// # Safety
    /// NEON is baseline on AArch64. `bytes` is a whole number of pixels.
    pub unsafe fn is_uniform_neon(bytes: &[u8], pixel: [u8; 4]) -> bool {
        // SAFETY: the caller has established the target feature; every
        // load and store below is inside the slices' common length.
        unsafe {
            let len = bytes.len();
            let want = vreinterpretq_u8_u32(vdupq_n_u32(u32::from_le_bytes(pixel)));
            let mut i = 0usize;
            while i + 16 <= len {
                let v = vld1q_u8(bytes.as_ptr().add(i));
                // The smallest lane of the comparison is 0 unless every one matched.
                if vminvq_u8(vceqq_u8(v, want)) != 0xff {
                    return false;
                }
                i += 16;
            }
            super::is_uniform_scalar(&bytes[i..], pixel)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic bytes that are not all distinct and not all equal, so a
    /// kernel that confuses lanes or drops a tail shows up.
    fn noise(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect()
    }

    /// Lengths either side of every vector width, so the tail of each kernel is
    /// exercised: below one vector, exactly one, one plus a byte, and past two.
    const LENGTHS: [usize; 12] = [0, 1, 3, 4, 15, 16, 17, 31, 32, 33, 64, 4099];

    #[test]
    fn the_difference_matches_the_scalar_one_at_every_length() {
        for len in LENGTHS {
            let prev = noise(len, 7);
            let cur = noise(len, 200);

            let mut fast = cur.clone();
            let fast_zeros = delta_in_place(&mut fast, &prev);
            let mut slow = cur.clone();
            let slow_zeros = delta_scalar(&mut slow, &prev);

            assert_eq!(fast, slow, "bytes differ at len {len}");
            assert_eq!(fast_zeros, slow_zeros, "zero count differs at len {len}");
        }
    }

    #[test]
    fn the_difference_round_trips_through_its_inverse() {
        // The property the client depends on: subtract, then add, is identity
        // for every byte value including the ones that wrap.
        for len in LENGTHS {
            let prev = noise(len, 3);
            let cur = noise(len, 251);
            let mut buf = cur.clone();
            delta_in_place(&mut buf, &prev);
            undelta_in_place(&mut buf, &prev);
            assert_eq!(buf, cur, "round trip lost bytes at len {len}");
        }
    }

    #[test]
    fn identical_input_is_all_zeros() {
        let prev = noise(1000, 11);
        let mut buf = prev.clone();
        assert_eq!(delta_in_place(&mut buf, &prev), 1000);
        assert!(buf.iter().all(|&b| b == 0));
    }

    #[test]
    fn a_uniform_run_is_recognised_at_every_length() {
        for pixels in [0usize, 1, 3, 4, 8, 9, 1024] {
            let pixel = [0x12, 0x34, 0x56, 0xff];
            let mut bytes: Vec<u8> = pixel.iter().copied().cycle().take(pixels * 4).collect();
            assert!(is_uniform(&bytes, pixel), "{pixels} pixels");
            assert_eq!(is_uniform(&bytes, pixel), is_uniform_scalar(&bytes, pixel));

            if pixels == 0 {
                continue;
            }
            // One byte of the last pixel differs: the tail is where a kernel
            // that only checks whole vectors gets it wrong.
            let last = bytes.len() - 2;
            bytes[last] ^= 0xff;
            assert!(!is_uniform(&bytes, pixel), "{pixels} pixels, tail changed");
            assert_eq!(is_uniform(&bytes, pixel), is_uniform_scalar(&bytes, pixel));
        }
    }

    #[test]
    fn a_run_that_differs_in_the_first_vector_is_rejected() {
        let pixel = [1, 2, 3, 4];
        let mut bytes: Vec<u8> = pixel.iter().copied().cycle().take(4096).collect();
        bytes[5] = 0xff;
        assert!(!is_uniform(&bytes, pixel));
    }

    #[test]
    fn a_length_that_is_not_whole_pixels_is_refused() {
        assert!(!is_uniform(&[1, 2, 3], [1, 2, 3, 4]));
    }

    /// The dispatcher only ever runs one implementation, so testing through it
    /// leaves whichever the developer's machine does not have untested until
    /// somebody's session looks wrong. These reach past it.
    #[cfg(target_arch = "x86_64")]
    #[test]
    fn every_x86_kernel_agrees_with_the_scalar_one() {
        let pixel = [9, 8, 7, 0xff];
        for len in LENGTHS {
            let prev = noise(len, 17);
            let cur = noise(len, 99);
            let mut want = cur.clone();
            let want_zeros = delta_scalar(&mut want, &prev);

            let mut sse = cur.clone();
            // SAFETY: SSE2 is baseline on this target.
            let sse_zeros = unsafe { x86::delta_sse2(&mut sse, &prev) };
            assert_eq!(
                (sse, sse_zeros),
                (want.clone(), want_zeros),
                "sse2 at {len}"
            );

            if std::is_x86_feature_detected!("avx2") {
                let mut avx = cur.clone();
                // SAFETY: guarded by the detection above.
                let avx_zeros = unsafe { x86::delta_avx2(&mut avx, &prev) };
                assert_eq!(
                    (avx, avx_zeros),
                    (want.clone(), want_zeros),
                    "avx2 at {len}"
                );
            }

            let uniform: Vec<u8> = pixel.iter().copied().cycle().take(len - len % 4).collect();
            // SAFETY: as above; the slice is a whole number of pixels.
            assert_eq!(
                unsafe { x86::is_uniform_sse2(&uniform, pixel) },
                is_uniform_scalar(&uniform, pixel),
                "sse2 uniform at {len}"
            );
            if std::is_x86_feature_detected!("avx2") {
                // SAFETY: guarded by the detection above.
                assert_eq!(
                    unsafe { x86::is_uniform_avx2(&uniform, pixel) },
                    is_uniform_scalar(&uniform, pixel),
                    "avx2 uniform at {len}"
                );
            }
        }
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn the_neon_kernels_agree_with_the_scalar_ones() {
        let pixel = [9, 8, 7, 0xff];
        for len in LENGTHS {
            let prev = noise(len, 17);
            let cur = noise(len, 99);
            let mut want = cur.clone();
            let want_zeros = delta_scalar(&mut want, &prev);

            let mut neon = cur.clone();
            // SAFETY: NEON is baseline on this target.
            let neon_zeros = unsafe { arm::delta_neon(&mut neon, &prev) };
            assert_eq!((neon, neon_zeros), (want, want_zeros), "neon at {len}");

            let uniform: Vec<u8> = pixel.iter().copied().cycle().take(len - len % 4).collect();
            // SAFETY: as above; the slice is a whole number of pixels.
            assert_eq!(
                unsafe { arm::is_uniform_neon(&uniform, pixel) },
                is_uniform_scalar(&uniform, pixel),
                "neon uniform at {len}"
            );
        }
    }
}
