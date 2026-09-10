import { boundedPNG } from "./png-validation.js";
import jpeg from "jpeg-js";
import { decode as png } from "fast-png";
import webp, { init } from "@jsquash/webp/decode.js";
import webpWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import { imageInfo, sha256 } from "../../../editor/package-validation.js";
let ready;
export async function validateRaster(bytes) {
  const info = imageInfo(bytes);
  let image;
  if (info.mime === "image/png")
    image = png(boundedPNG(bytes, info.width, info.height), { checkCrc: true });
  else if (info.mime === "image/jpeg")
    image = jpeg.decode(bytes, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: 24,
      maxMemoryUsageInMB: 100,
    });
  else {
    ready ??= init(webpWasm);
    await ready;
    image = await webp(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  if (image.width !== info.width || image.height !== info.height)
    throw new Error("Decoded image dimensions disagree.");
  return { ...info, contentHash: await sha256(bytes) };
}
