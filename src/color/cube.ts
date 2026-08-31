/**
 * Parser de archivos .cube (Adobe/Iridas), el formato en el que vienen los LUTs
 * de Sony (S-Log3), GoPro (GP-Log) y DJI (D-Log M).
 */

export interface Lut3D {
  /** N, el lado del cubo. Tipicamente 17, 33 o 65. */
  size: number;
  /** Rango de entrada del LUT. Casi siempre 0..1, pero algunos LUTs usan otro. */
  domainMin: readonly [number, number, number];
  domainMax: readonly [number, number, number];
  /** N*N*N*3 floats en orden RGB. El rojo es el que varia mas rapido. */
  data: Float32Array;
  title?: string;
}

export class CubeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeParseError';
  }
}

const MAX_SIZE = 129;

function parseFloats(line: string, expected: number, context: string): number[] {
  const parts = line.split(/\s+/).filter((p) => p !== '');
  if (parts.length !== expected) {
    throw new CubeParseError(
      `${context}: esperaba ${expected} numeros y encontre ${parts.length} ("${line}")`,
    );
  }
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n)) {
      throw new CubeParseError(`${context}: "${p}" no es un numero`);
    }
    return n;
  });
}

export function parseCube(text: string): Lut3D {
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let written = 0;

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (/^TITLE\b/i.test(trimmed)) {
      const quoted = /"([^"]*)"/.exec(trimmed);
      title = quoted?.[1] ?? trimmed.slice(5).trim();
      continue;
    }

    // Los comentarios al final de linea son legales fuera de TITLE.
    const hash = trimmed.indexOf('#');
    const line = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
    if (line === '') continue;

    if (/^LUT_1D_SIZE\b/i.test(line)) {
      throw new CubeParseError(
        'Este archivo es un LUT 1D. La app solo trabaja con LUTs 3D (LUT_3D_SIZE), ' +
          'que son los que usan las conversiones de log a Rec.709.',
      );
    }

    if (/^LUT_3D_SIZE\b/i.test(line)) {
      const [n] = parseFloats(line.slice(11), 1, `linea ${i + 1}, LUT_3D_SIZE`);
      if (!Number.isInteger(n) || n! < 2 || n! > MAX_SIZE) {
        throw new CubeParseError(
          `linea ${i + 1}: LUT_3D_SIZE invalido (${n}); tiene que ser un entero entre 2 y ${MAX_SIZE}`,
        );
      }
      if (data) throw new CubeParseError(`linea ${i + 1}: LUT_3D_SIZE aparece dos veces`);
      size = n!;
      data = new Float32Array(size * size * size * 3);
      continue;
    }

    if (/^DOMAIN_MIN\b/i.test(line)) {
      const v = parseFloats(line.slice(10), 3, `linea ${i + 1}, DOMAIN_MIN`);
      domainMin = [v[0]!, v[1]!, v[2]!];
      continue;
    }

    if (/^DOMAIN_MAX\b/i.test(line)) {
      const v = parseFloats(line.slice(10), 3, `linea ${i + 1}, DOMAIN_MAX`);
      domainMax = [v[0]!, v[1]!, v[2]!];
      continue;
    }

    if (/^[A-Za-z_]/.test(line)) {
      // Palabra clave desconocida: la ignoro en vez de romper, para tolerar
      // archivos con metadatos de fabricante.
      continue;
    }

    if (!data) {
      throw new CubeParseError(
        `linea ${i + 1}: hay datos antes de LUT_3D_SIZE, no se cuanto espacio reservar`,
      );
    }
    if (written + 3 > data.length) {
      throw new CubeParseError(
        `El archivo tiene mas entradas de las que declara LUT_3D_SIZE ${size} ` +
          `(esperaba ${size ** 3}, encontre mas)`,
      );
    }
    const rgb = parseFloats(line, 3, `linea ${i + 1}`);
    data[written++] = rgb[0]!;
    data[written++] = rgb[1]!;
    data[written++] = rgb[2]!;
  }

  if (!data) {
    throw new CubeParseError('No encontre LUT_3D_SIZE: esto no parece un archivo .cube 3D.');
  }
  if (written !== data.length) {
    throw new CubeParseError(
      `Archivo incompleto: LUT_3D_SIZE ${size} necesita ${size ** 3} entradas ` +
        `y encontre ${written / 3}.`,
    );
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c]! > domainMin[c]!)) {
      throw new CubeParseError(
        `DOMAIN_MAX tiene que ser mayor que DOMAIN_MIN en los tres canales ` +
          `(canal ${c}: min=${domainMin[c]}, max=${domainMax[c]})`,
      );
    }
  }

  return { size, domainMin, domainMax, data, title };
}

/**
 * Evalua el LUT en CPU con interpolacion trilineal, igual que lo hace la GPU.
 * Existe para poder verificar el shader contra ffmpeg sin depender de WebGL.
 */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const { size, data, domainMin, domainMax } = lut;
  const input = [r, g, b];
  const idx: number[] = [];
  const frac: number[] = [];

  for (let c = 0; c < 3; c++) {
    const norm = (input[c]! - domainMin[c]!) / (domainMax[c]! - domainMin[c]!);
    const pos = Math.min(Math.max(norm, 0), 1) * (size - 1);
    const i0 = Math.min(Math.floor(pos), size - 2);
    idx.push(i0);
    frac.push(pos - i0);
  }

  const at = (ri: number, gi: number, bi: number, ch: number): number =>
    data[((bi * size + gi) * size + ri) * 3 + ch]!;

  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let acc = 0;
    for (let corner = 0; corner < 8; corner++) {
      const dr = corner & 1;
      const dg = (corner >> 1) & 1;
      const db = (corner >> 2) & 1;
      const w =
        (dr ? frac[0]! : 1 - frac[0]!) *
        (dg ? frac[1]! : 1 - frac[1]!) *
        (db ? frac[2]! : 1 - frac[2]!);
      if (w === 0) continue;
      acc += w * at(idx[0]! + dr, idx[1]! + dg, idx[2]! + db, ch);
    }
    out[ch] = acc;
  }
  return out;
}
