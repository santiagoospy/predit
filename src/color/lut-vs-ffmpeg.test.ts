import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCube, sampleLut } from './cube';

/**
 * El test que garantiza que el color no miente.
 *
 * Aplica el mismo LUT con ffmpeg (la referencia de la industria) y con nuestro
 * codigo, sobre los mismos pixeles, y compara. Si esto pasa, lo que ves en el
 * telefono es de verdad tu look y no una aproximacion.
 *
 * Se compara contra interp=trilinear porque es exactamente lo que hace la GPU
 * al filtrar una textura 3D: el shader y sampleLut implementan la misma cuenta.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const LUT_SIZE = 33;

/** Un LUT deliberadamente no lineal, para que cualquier error de interpolacion salte. */
function buildTestCube(): string {
  const n = LUT_SIZE;
  const lines = [`TITLE "LUT de verificacion"`, `LUT_3D_SIZE ${n}`];
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        const r = ri / (n - 1);
        const g = gi / (n - 1);
        const b = bi / (n - 1);
        // Curva de gamma (como una conversion de log) mas mezcla entre canales,
        // que es donde un error de orden RGB/BGR se haria evidente.
        const or = clamp01(Math.pow(r, 1 / 2.2) * 0.9 + g * 0.08);
        const og = clamp01(Math.pow(g, 1 / 1.8) * 0.95 + b * 0.04);
        const ob = clamp01(Math.pow(b, 1 / 2.6) * 0.85 + r * 0.12);
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n');
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/** Colores de prueba: las 8 esquinas, la rampa de grises y ruido determinista. */
function buildTestPixels(count: number): Uint8Array {
  const px = new Uint8Array(count * 3);
  let i = 0;
  const push = (r: number, g: number, b: number) => {
    if (i + 3 > px.length) return;
    px[i++] = r;
    px[i++] = g;
    px[i++] = b;
  };

  for (let c = 0; c < 8; c++) {
    push((c & 1) * 255, ((c >> 1) & 1) * 255, ((c >> 2) & 1) * 255);
  }
  for (let v = 0; v < 256; v++) push(v, v, v);

  // PRNG determinista, para que el test de siempre el mismo resultado.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed & 0xff;
  };
  while (i < px.length) push(rand(), rand(), rand());

  return px;
}

describe.skipIf(!hasFfmpeg)('el LUT coincide con ffmpeg', () => {
  it('trilineal, LUT 33 cubos, sobre 4096 colores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colosos-lut-'));
    try {
      const cubeText = buildTestCube();
      writeFileSync(join(dir, 'test.cube'), cubeText);

      const width = 64;
      const height = 64;
      const input = buildTestPixels(width * height);
      writeFileSync(join(dir, 'in.raw'), input);

      execFileSync(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`,
          '-i', 'in.raw',
          '-vf', 'lut3d=file=test.cube:interp=trilinear',
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', 'out.raw',
        ],
        { cwd: dir },
      );

      const expected = new Uint8Array(readFileSync(join(dir, 'out.raw')));
      expect(expected.length).toBe(input.length);

      const lut = parseCube(cubeText);
      let maxDiff = 0;
      let sumDiff = 0;
      let worstAt = -1;

      for (let p = 0; p < input.length; p += 3) {
        const out = sampleLut(lut, input[p]! / 255, input[p + 1]! / 255, input[p + 2]! / 255);
        for (let c = 0; c < 3; c++) {
          // ffmpeg trunca al pasar a 8 bits; nosotros redondeamos, que es mas
          // exacto (truncar oscurece medio nivel de forma sistematica). Para que
          // la comparacion mida la CUENTA y no la convencion de redondeo, aca
          // truncamos igual que ffmpeg.
          const ours = Math.min(255, Math.floor(clamp01(out[c]!) * 255));
          const diff = Math.abs(ours - expected[p + c]!);
          sumDiff += diff;
          if (diff > maxDiff) {
            maxDiff = diff;
            worstAt = p;
          }
        }
      }

      const meanDiff = sumDiff / input.length;
      const worst = worstAt >= 0
        ? `rgb(${input[worstAt]},${input[worstAt + 1]},${input[worstAt + 2]})`
        : 'ninguno';

      // Tolerancia de 1 nivel: es el redondeo a 8 bits, no un error de cuenta.
      expect(maxDiff, `peor diferencia en ${worst}`).toBeLessThanOrEqual(1);
      expect(meanDiff).toBeLessThan(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
