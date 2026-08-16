//! A minimal PNG writer, for the capture harness.
//!
//! Dependency-free on purpose: this binary is uploaded to other people's
//! machines, and a screenshot tool does not justify an image crate. The zlib
//! stream uses stored (uncompressed) deflate blocks, which is a legal stream
//! every decoder accepts — the files are large, but they exist to be looked at
//! once, not shipped.

/// Encode BGRA pixels (the compositor's native order) as an RGBA PNG.
pub fn encode_bgra(width: u32, height: u32, stride: u32, pixels: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0); // filter: none
        let row = y * stride as usize;
        for x in 0..width as usize {
            let at = row + x * 4;
            if at + 3 >= pixels.len() {
                raw.extend_from_slice(&[0, 0, 0, 255]);
                continue;
            }
            let (b, g, r, a) = (pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]);
            raw.extend_from_slice(&[r, g, b, a]);
        }
    }

    let mut out = Vec::with_capacity(raw.len() + 4096);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit, RGBA, deflate, no filter, no interlace
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = Crc32::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.finish().to_be_bytes());
}

/// A zlib stream of stored deflate blocks.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 65535 * 5 + 6);
    out.extend_from_slice(&[0x78, 0x01]); // deflate, 32K window, no preset dict

    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }
    for (i, block) in data.chunks(65535).enumerate() {
        let last = (i + 1) * 65535 >= data.len();
        out.push(if last { 1 } else { 0 });
        out.extend_from_slice(&(block.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        out.extend_from_slice(block);
    }

    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

struct Crc32 {
    value: u32,
}

impl Crc32 {
    fn new() -> Self {
        Self { value: 0xffff_ffff }
    }

    fn update(&mut self, data: &[u8]) {
        for &byte in data {
            let index = ((self.value ^ byte as u32) & 0xff) as usize;
            self.value = CRC_TABLE[index] ^ (self.value >> 8);
        }
    }

    fn finish(self) -> u32 {
        self.value ^ 0xffff_ffff
    }
}

const CRC_TABLE: [u32; 256] = build_crc_table();

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_well_formed_header() {
        let png = encode_bgra(2, 1, 8, &[1, 2, 3, 255, 4, 5, 6, 255]);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 2);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 1);
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn crc32_matches_the_known_vector() {
        // The PNG spec's CRC is the same one zlib publishes a check value for.
        let mut crc = Crc32::new();
        crc.update(b"123456789");
        assert_eq!(crc.finish(), 0xcbf4_3926);
    }

    #[test]
    fn adler32_matches_the_known_vector() {
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }

    #[test]
    fn stored_blocks_carry_every_byte() {
        // Two blocks' worth, to catch an off-by-one in the final-block flag.
        let data = vec![7u8; 70_000];
        let stream = zlib_stored(&data);
        assert_eq!(stream[0], 0x78);
        // 2 header + 5 per block header + payload + 4 adler
        assert_eq!(stream.len(), 2 + 5 + 65535 + 5 + 4465 + 4);
        assert_eq!(stream[2], 0, "first block is not final");
        assert_eq!(stream[2 + 5 + 65535], 1, "second block is final");
    }

    #[test]
    fn swaps_blue_and_red() {
        // One pixel, BGRA in and RGBA out: the byte order is the thing this
        // writer exists to get right.
        let png = encode_bgra(1, 1, 4, &[0x11, 0x22, 0x33, 0xff]);
        let idat_at = png
            .windows(4)
            .position(|w| w == b"IDAT")
            .expect("IDAT present");
        // chunk name, then the zlib header and stored-block header.
        let payload = &png[idat_at + 4 + 2 + 5..];
        assert_eq!(&payload[..5], &[0x00, 0x33, 0x22, 0x11, 0xff]);
    }
}
