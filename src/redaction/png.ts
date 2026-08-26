import { deflateSync, inflateSync } from 'node:zlib';

/**
 * ================================================================================================
 * A MINIMAL PNG READ / DRAW / WRITE, BUILT ON NODE'S OWN zlib.
 * ================================================================================================
 *
 * Masking has to change PIXELS. Asserting that a manifest lists a region proves only that we wrote
 * a manifest; the claim being made is that the sensitive value is not in the image, and the only
 * way to test that claim is to compare the bytes.
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN A LIBRARY. `sharp`, `pngjs` and `jimp` would each do this in
 * three lines, and every one of them is a dependency the phase prompt did not name (Hard Rule 5).
 * `zlib` is in Node, PNG is a simple container, and the subset needed here - 8-bit RGBA,
 * non-interlaced, which is what every browser screenshot is - is about a hundred lines. Anything
 * outside that subset is REFUSED with a message saying so rather than decoded incorrectly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: interlacing, palettes, 16-bit channels, ancillary chunk
 * preservation. A screenshot has none of those, and silently mishandling one would produce a
 * corrupt image that still looks masked.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. Mutable: that is the point. */
  readonly pixels: Buffer;
}

export function decodePng(data: Buffer): RgbaImage {
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body.readUInt8(8);
      const colorType = body.readUInt8(9);
      const interlace = body.readUInt8(12);
      if (bitDepth !== 8) throw new Error('unsupported PNG bit depth ' + bitDepth + ' (need 8)');
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (colorType === 6) channels = 4;
      else if (colorType === 2) channels = 3;
      else throw new Error('unsupported PNG color type ' + colorType + ' (need 2 or 6)');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);

  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(read);
    read += 1;
    raw.copy(line, 0, read, read + stride);
    read += stride;

    // The five PNG filters, undone in place. `a` is the byte one pixel to the left, `b` the byte
    // directly above, `c` the byte above-left.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (line[i - channels] as number) : 0;
      const b = previous[i] as number;
      const c = i >= channels ? (previous[i - channels] as number) : 0;
      const x = line[i] as number;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error('unknown PNG filter type ' + filter);
      }
      line[i] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = line[from] as number;
      pixels[to + 1] = line[from + 1] as number;
      pixels[to + 2] = line[from + 2] as number;
      pixels[to + 3] = channels === 4 ? (line[from + 3] as number) : 255;
    }

    line.copy(previous);
  }

  return { width, height, pixels };
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

export function encodePng(image: RgbaImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Filter type 0 on every scanline. Adaptive filtering would compress better and buy nothing here:
  // these images are written once and read by a person.
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw.writeUInt8(0, y * (stride + 1));
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Paint a solid rectangle. Opaque, flat, and the same colour every time.
 *
 * NOT a blur and NOT pixelation. Both of those are reversible to a useful degree - a blurred
 * six-digit number is recoverable, and a pixelated one often is by eye - and both look like
 * redaction to a reviewer, which is the property that makes them dangerous.
 */
export function fillRect(image: RgbaImage, rect: Rect, colour = [17, 17, 17, 255]): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * image.width + x) * 4;
      image.pixels[at] = colour[0] as number;
      image.pixels[at + 1] = colour[1] as number;
      image.pixels[at + 2] = colour[2] as number;
      image.pixels[at + 3] = colour[3] as number;
    }
  }
}

/** How many pixels differ. Used by tests to prove masking changed the image rather than a manifest. */
export function pixelsDiffering(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('images differ in size');
  let count = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    if (
      a.pixels[i] !== b.pixels[i] ||
      a.pixels[i + 1] !== b.pixels[i + 1] ||
      a.pixels[i + 2] !== b.pixels[i + 2]
    ) {
      count += 1;
    }
  }
  return count;
}
