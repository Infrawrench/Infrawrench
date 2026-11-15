//! The wyhash variant Bun names its isolated store's directories with.
//!
//! A package installed against a given set of peer dependencies sits in
//! `node_modules/.bun/<name>@<version>+<hash>`, and the hash is this
//! function over the peers' names and versions. It is the older wyhash
//! (32-byte rounds, five primes) that Zig's standard library shipped and
//! Bun kept as `Wyhash11`; computing the same value is what makes the
//! directories match a real install name for name.

const PRIMES: [u64; 5] = [
    0xa076_1d64_78bd_642f,
    0xe703_7ed1_a0b4_28db,
    0x8ebc_6af0_9c88_c6e3,
    0x5899_65cc_7537_4cc3,
    0x1d8e_4e27_c47d_124f,
];

fn read(bytes: &[u8], len: usize) -> u64 {
    let mut buffer = [0u8; 8];
    buffer[..len].copy_from_slice(&bytes[..len]);
    u64::from_le_bytes(buffer)
}

/// Eight bytes as two little-endian words, the first one high.
fn swapped(bytes: &[u8]) -> u64 {
    (read(bytes, 4) << 32) | read(&bytes[4..], 4)
}

/// One to eight trailing bytes, packed the way the reference does.
fn part(bytes: &[u8]) -> u64 {
    match bytes.len() {
        1 => read(bytes, 1),
        2 => read(bytes, 2),
        3 => (read(bytes, 2) << 8) | read(&bytes[2..], 1),
        4 => read(bytes, 4),
        5 => (read(bytes, 4) << 8) | read(&bytes[4..], 1),
        6 => (read(bytes, 4) << 16) | read(&bytes[4..], 2),
        7 => (read(bytes, 4) << 24) | (read(&bytes[4..], 2) << 8) | read(&bytes[6..], 1),
        _ => swapped(bytes),
    }
}

fn mum(a: u64, b: u64) -> u64 {
    let product = u128::from(a) * u128::from(b);
    ((product >> 64) ^ product) as u64
}

fn mix0(a: u64, b: u64, seed: u64) -> u64 {
    mum(a ^ seed ^ PRIMES[0], b ^ seed ^ PRIMES[1])
}

fn mix1(a: u64, b: u64, seed: u64) -> u64 {
    mum(a ^ seed ^ PRIMES[2], b ^ seed ^ PRIMES[3])
}

/// The hash of `input` with seed 0.
pub fn wyhash11(input: &[u8]) -> u64 {
    let mut seed = 0u64;
    let (chunks, rest) = input.as_chunks::<32>();
    for chunk in chunks {
        seed = mix0(read(chunk, 8), read(&chunk[8..], 8), seed)
            ^ mix1(read(&chunk[16..], 8), read(&chunk[24..], 8), seed);
    }
    seed = match rest.len() {
        0 => seed,
        1..=8 => mix0(part(rest), PRIMES[4], seed),
        9..=16 => mix0(swapped(rest), part(&rest[8..]), seed),
        17..=24 => {
            mix0(swapped(rest), swapped(&rest[8..]), seed)
                ^ mix1(part(&rest[16..]), PRIMES[4], seed)
        }
        _ => {
            mix0(swapped(rest), swapped(&rest[8..]), seed)
                ^ mix1(swapped(&rest[16..]), part(&rest[24..]), seed)
        }
    };
    mum(seed ^ input.len() as u64, PRIMES[4])
}

#[cfg(test)]
mod tests {
    use super::wyhash11;

    /// The suffixes Bun 1.4.4 gave `react-dom@18.3.1` installed against
    /// `react@18.3.1` and against `react@18.2.0` (`fixtures/peers`).
    #[test]
    fn matches_the_suffixes_a_real_install_wrote() {
        assert_eq!(wyhash11(b"react18.3.1"), 0xf4ea_cebf_2041_cd4f);
        assert_eq!(wyhash11(b"react18.2.0"), 0x5e44_3928_92a7_cd3e);
    }

    #[test]
    fn every_tail_length_and_a_full_round_hash_differently() {
        let input: Vec<u8> = (0u8..80).collect();
        let hashes: std::collections::BTreeSet<u64> = (0..=input.len())
            .map(|len| wyhash11(&input[..len]))
            .collect();
        assert_eq!(hashes.len(), input.len() + 1);
    }
}
