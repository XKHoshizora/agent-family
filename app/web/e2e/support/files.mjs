// Files to send: a real PNG of a chosen size (so a displayed image can be told from the 128×128 default avatar
// and checked by its natural size) and random bytes.
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGB PNG of `width` × `height` with a random colour gradient (a different file every call). */
export function png(width, height) {
  const [r, g, b] = randomBytes(3);
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * row + 1 + x * 3;
      raw[at] = (r + x) & 0xff;
      raw[at + 1] = (g + y) & 0xff;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * `size` bytes, random after a fixed prefix that no file signature starts with (random leading bytes could, by
 * chance, look like a known type): the service serves them as a download.
 */
export const randomFile = (size) => Buffer.concat([Buffer.from("AF-E2E\u0000", "latin1"), randomBytes(Math.max(0, size - 7))]);
