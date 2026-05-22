/**
 * Convert RGBA buffer to BGRA in place or into a reusable output buffer.
 * @param {Buffer|Uint8Array} rgba
 * @param {Buffer} [out]
 * @returns {Buffer}
 */
function rgbaToBgra(rgba, out) {
  const len = rgba.length;
  const bgra = out && out.length === len ? out : Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 4) {
    bgra[i] = rgba[i + 2];
    bgra[i + 1] = rgba[i + 1];
    bgra[i + 2] = rgba[i];
    bgra[i + 3] = rgba[i + 3];
  }
  return bgra;
}

module.exports = { rgbaToBgra };
