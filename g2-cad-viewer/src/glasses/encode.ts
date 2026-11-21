// Frame encoding for the glasses.
//
// The G2 shows 16 shades (4-bit greyscale). The SDK accepts common image
// formats and converts them to 4-bit itself, but a full-colour RGBA PNG from
// canvas.toBlob() is large: every byte travels through the WebView bridge (as
// a JSON number array) before the Even app decodes, greys and LZ4-compresses
// it for Bluetooth.
//
// "Compact" encoding does that reduction here instead: each pixel is mapped to
// one of the 16 shades and written as a 4-bit greyscale PNG (2 pixels per
// byte). Line drawings on black compress extremely well in that form, so the
// payload is a small fraction of the RGBA PNG and the Even app has almost
// nothing left to convert.

export type ImageEncoding = 'compact' | 'standard'

export interface EncodedTile {
  bytes: Uint8Array
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const typeBytes = new TextEncoder().encode(type)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32([typeBytes, data]))
  return out
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') produces a zlib (RFC 1950) stream, as PNG requires.
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const compactSupported = () => typeof CompressionStream !== 'undefined'

/** RGBA pixels → 16-shade 4-bit greyscale PNG. */
export async function encodeGray4Png(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const rowBytes = Math.ceil(width / 2)
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const lum = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
      const level = (lum * 15 + 127) / 255 | 0
      const at = row + 1 + (x >> 1)
      raw[at] |= x & 1 ? level : level << 4
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = 4 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Full-colour PNG straight from the canvas (the original path). */
export async function encodeCanvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}
