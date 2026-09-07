/**
 * El lector de cajas contra un MP4 armado a mano.
 *
 * Se construye un archivo minimo pero con la estructura real -ftyp, moov con
 * dos pistas, mdat aparte- y se comprueba que salgan los offsets correctos.
 * Es lo unico que se puede verificar sin un clip de camara: que la aritmetica
 * de las tablas este bien.
 */

import { describe, expect, it } from 'vitest';

import { leerMuestras, pistasDeMetadata } from './mp4';

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function letras(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** Una caja: tamano, tipo y contenido. */
function caja(tipo: string, contenido: number[]): number[] {
  return [...u32(contenido.length + 8), ...letras(tipo), ...contenido];
}

interface Pista {
  handler: string;
  formato: string;
  /** Tamano de cada muestra, en el orden en que van en el archivo. */
  tamanos: number[];
  duracion: number;
  timescale: number;
}

function trak(p: Pista, offsetDelTrozo: number): number[] {
  const hdlr = caja('hdlr', [...u32(0), ...u32(0), ...letras(p.handler), ...u32(0), ...u32(0), ...u32(0), 0]);
  // version 0: creation, modification, timescale, duration.
  const mdhd = caja('mdhd', [
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(p.timescale),
    ...u32(p.tamanos.length * p.duracion),
    ...u16(0),
    ...u16(0),
  ]);
  const stsd = caja('stsd', [...u32(0), ...u32(1), ...caja(p.formato, [...new Array<number>(8).fill(0)])]);
  const stts = caja('stts', [...u32(0), ...u32(1), ...u32(p.tamanos.length), ...u32(p.duracion)]);
  const stsz = caja('stsz', [
    ...u32(0),
    ...u32(0),
    ...u32(p.tamanos.length),
    ...p.tamanos.flatMap(u32),
  ]);
  // Un solo trozo con todas las muestras adentro.
  const stsc = caja('stsc', [...u32(0), ...u32(1), ...u32(1), ...u32(p.tamanos.length), ...u32(1)]);
  const stco = caja('stco', [...u32(0), ...u32(1), ...u32(offsetDelTrozo)]);
  const stbl = caja('stbl', [...stsd, ...stts, ...stsz, ...stsc, ...stco]);
  const minf = caja('minf', stbl);
  const mdia = caja('mdia', [...mdhd, ...hdlr, ...minf]);
  return caja('trak', mdia);
}

/**
 * Arma un archivo con una pista de video y una de metadata.
 *
 * El mdat va al final y el moov antes, que es como lo escriben las camaras; el
 * caso contrario (moov al final) lo cubre otro test.
 */
function archivo(tamanos: number[], formato = 'rtmd', moovAlFinal = false) {
  const ftyp = caja('ftyp', letras('isom').concat(u32(512), letras('isomiso2')));
  const total = tamanos.reduce((a, b) => a + b, 0);
  const datos = new Array<number>(total).fill(0).map((_, i) => i % 251);

  // El offset del trozo depende del tamano del moov, y el moov depende del
  // offset: se arma dos veces, la primera con un offset provisorio, para saber
  // cuanto ocupa.
  let offset = 0;
  let moov: number[] = [];
  for (let intento = 0; intento < 3; intento++) {
    const video = trak(
      { handler: 'vide', formato: 'avc1', tamanos: [4], duracion: 1, timescale: 30 },
      offset,
    );
    const meta = trak({ handler: 'meta', formato, tamanos, duracion: 1, timescale: 2 }, offset);
    moov = caja('moov', [...video, ...meta]);
    const mdatEmpieza = moovAlFinal
      ? ftyp.length + 8
      : ftyp.length + moov.length + 8;
    if (offset === mdatEmpieza) break;
    offset = mdatEmpieza;
  }

  const mdat = caja('mdat', datos);
  const bytes = moovAlFinal ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat];
  return { file: new File([new Uint8Array(bytes)], 'clip.mp4'), datos };
}

describe('pistasDeMetadata', () => {
  it('encuentra la pista de metadata y saltea la de video', async () => {
    const { file } = archivo([10, 10, 10]);
    const pistas = await pistasDeMetadata(file);
    expect(pistas).toHaveLength(1);
    expect(pistas[0]!.handler).toBe('meta');
    expect(pistas[0]!.formato).toBe('rtmd');
  });

  it('calcula los segundos con el timescale de la pista', async () => {
    const { file } = archivo([10, 10, 10]);
    const [pista] = await pistasDeMetadata(file);
    // timescale 2 y duracion 1 por muestra: media hora... media segundo cada una.
    expect(pista!.muestras.map((m) => m.segundo)).toEqual([0, 0.5, 1]);
  });

  it('encadena los offsets dentro del trozo', async () => {
    const { file } = archivo([10, 20, 5]);
    const [pista] = await pistasDeMetadata(file);
    const offsets = pista!.muestras.map((m) => m.offset);
    expect(offsets[1]! - offsets[0]!).toBe(10);
    expect(offsets[2]! - offsets[1]!).toBe(20);
    expect(pista!.muestras.map((m) => m.tamano)).toEqual([10, 20, 5]);
  });

  it('encuentra el moov aunque este despues del mdat', async () => {
    const { file } = archivo([10, 10], 'rtmd', true);
    const pistas = await pistasDeMetadata(file);
    expect(pistas).toHaveLength(1);
    expect(pistas[0]!.muestras).toHaveLength(2);
  });

  it('reconoce el formato de GoPro', async () => {
    const { file } = archivo([10], 'gpmd');
    const [pista] = await pistasDeMetadata(file);
    expect(pista!.formato).toBe('gpmd');
  });

  it('devuelve vacio si el archivo no tiene moov', async () => {
    const file = new File([new Uint8Array(caja('ftyp', letras('isom')))], 'x.mp4');
    expect(await pistasDeMetadata(file)).toEqual([]);
  });
});

describe('leerMuestras', () => {
  it('trae exactamente los bytes de cada muestra', async () => {
    const { file, datos } = archivo([10, 20, 5]);
    const [pista] = await pistasDeMetadata(file);
    const bloques = await leerMuestras(file, pista!.muestras);

    expect(bloques.map((b) => b.byteLength)).toEqual([10, 20, 5]);
    // El contenido del mdat es una rampa: la primera muestra son sus 10 primeros.
    expect([...new Uint8Array(bloques[0]!)]).toEqual(datos.slice(0, 10));
    expect([...new Uint8Array(bloques[1]!)]).toEqual(datos.slice(10, 30));
  });

  it('no lee nada si no hay muestras', async () => {
    const { file } = archivo([10]);
    expect(await leerMuestras(file, [])).toEqual([]);
  });
});
