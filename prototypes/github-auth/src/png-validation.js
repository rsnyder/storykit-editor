import { Unzlib } from "fflate";
/** Discard optional metadata before decoding. Compressed profiles/text must not
 * become an unbounded second decompression channel. Verify all original CRCs. */
export function boundedPNG(bytes, width, height) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    chunks = [bytes.subarray(0, 8)];
  const crc = (input) => {
    let c = 0xffffffff;
    for (const byte of input) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[bytes[25]],
    depth = bytes[24];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth))
    throw new Error("Unsupported PNG color format.");
  // Includes scanline filters and Adam7 pass rounding, without trusting IDAT.
  const maximum =
    Math.ceil((width * channels * depth) / 8) * height +
    height * 8 +
    width * 8 +
    1024;
  if (maximum > 64 * 1024 * 1024)
    throw new Error("PNG decoded data exceeds the validation memory limit.");
  let expanded = 0,
    ended = false,
    seenHeader = false;
  const inflater = new Unzlib((data, final) => {
    expanded += data.length;
    if (expanded > maximum)
      throw new Error("PNG expansion exceeds its dimensions.");
    if (final) ended = true;
  });
  for (let p = 8; p < bytes.length; ) {
    const n = view.getUint32(p),
      type = String.fromCharCode(...bytes.subarray(p + 4, p + 8)),
      end = p + n + 12;
    if (crc(bytes.subarray(p + 4, end - 4)) !== view.getUint32(end - 4))
      throw new Error("PNG checksum mismatch.");
    if (type === "IHDR") {
      if (seenHeader) throw new Error("Duplicate PNG header.");
      seenHeader = true;
    }
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type))
      chunks.push(bytes.subarray(p, end));
    else if (type[0] === type[0].toUpperCase())
      throw new Error("Unsupported critical PNG chunk.");
    if (type === "IDAT")
      for (let at = p + 8; at < end - 4; at += 1024)
        inflater.push(bytes.subarray(at, Math.min(at + 1024, end - 4)));
    p = end;
  }
  inflater.push(new Uint8Array(), true);
  if (!ended || !expanded) throw new Error("Incomplete PNG pixels.");
  const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
