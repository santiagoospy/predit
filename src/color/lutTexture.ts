import type { Lut3D } from './cube';

/**
 * Sube un LUT 3D a la GPU como textura RGBA16F.
 *
 * Media precision (16 bits) en vez de 8: los LUTs de log a Rec.709 tienen curvas
 * muy empinadas en las sombras, y con 8 bits por entrada aparecen escalones.
 * WebGL2 filtra RGBA16F de forma nativa, asi que la interpolacion trilineal
 * la hace el hardware gratis.
 */
export function createLutTexture(gl: WebGL2RenderingContext, lut: Lut3D): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('No se pudo crear la textura del LUT');

  const { size, data } = lut;
  const half = new Uint16Array(size * size * size * 4);
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    half[o] = floatToHalf(data[i]!);
    half[o + 1] = floatToHalf(data[i + 1]!);
    half[o + 2] = floatToHalf(data[i + 2]!);
    half[o + 3] = 0x3c00; // 1.0 en media precision
  }

  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.HALF_FLOAT, half,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D, null);

  return tex;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Conversion IEEE 754 de simple a media precision. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0]!;
  const sign = (bits >>> 16) & 0x8000;
  let exp = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exp === 0xff) {
    // Infinito o NaN
    return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  }

  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // desborda: infinito
  if (e <= 0) {
    if (e < -10) return sign; // demasiado chico: cero
    // Subnormal
    mantissa |= 0x800000;
    const shift = 14 - e;
    const sub = mantissa >>> shift;
    const round = (mantissa >>> (shift - 1)) & 1;
    return sign | (sub + round);
  }

  const round = (mantissa >>> 12) & 1;
  let out = sign | (e << 10) | (mantissa >>> 13);
  if (round) out += 1; // el acarreo hacia el exponente sale solo por la suma
  return out & 0xffff;
}
