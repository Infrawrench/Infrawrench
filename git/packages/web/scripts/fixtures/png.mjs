/** A tiny PNG encoder for fixture images: RGBA, no filtering. */
import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** `pixel(x, y)` answers `[r, g, b, a]`. */
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A network diagram: tiers of boxes joined by a spine. `tiers` is boxes per row. */
export function diagram(width, height, tiers) {
  const boxes = [];
  const rowHeight = height / tiers.length;
  tiers.forEach((count, tier) => {
    const cell = width / count;
    for (let i = 0; i < count; i++) {
      boxes.push({
        x0: Math.round(cell * i + cell * 0.2),
        x1: Math.round(cell * i + cell * 0.8),
        y0: Math.round(rowHeight * tier + rowHeight * 0.28),
        y1: Math.round(rowHeight * tier + rowHeight * 0.72),
        tier,
      });
    }
  });
  const shades = [
    [39, 39, 42],
    [82, 82, 90],
    [161, 161, 170],
  ];
  return png(width, height, (x, y) => {
    for (const box of boxes) {
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) {
        const edge = x === box.x0 || x === box.x1 || y === box.y0 || y === box.y1;
        const [r, g, b] = shades[box.tier % shades.length];
        return edge ? [24, 24, 27, 255] : [r, g, b, 255];
      }
    }
    const mid = Math.round(width / 2);
    if (Math.abs(x - mid) <= 1 && y > rowHeight * 0.72 && y < height - rowHeight * 0.72)
      return [113, 113, 122, 255];
    return [247, 247, 248, 255];
  });
}
