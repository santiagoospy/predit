import { describe, expect, it } from 'vitest';
import { computeFitTransform, type Framing } from './renderer';

/**
 * La matriz de encuadre es codigo puro, asi que se puede verificar sin GPU.
 * Aplicamos la matriz a las cuatro esquinas del cuadro y comprobamos donde caen
 * en el lienzo (-1 a 1 en cada eje).
 */
function transformCorner(m: Float32Array, x: number, y: number): [number, number] {
  return [
    m[0]! * x + m[3]! * y + m[6]!,
    m[1]! * x + m[4]! * y + m[7]!,
  ];
}

const base = { mode: 'contain' as const, textureWidth: 1920, textureHeight: 1080 };

describe('computeFitTransform', () => {
  it('sin rotacion y con el mismo aspecto, deja la imagen tal cual', () => {
    const m = computeFitTransform(base, 1920, 1080);
    expect(transformCorner(m, 1, 1)[0]).toBeCloseTo(1, 6);
    expect(transformCorner(m, 1, 1)[1]).toBeCloseTo(1, 6);
    expect(transformCorner(m, -1, -1)[0]).toBeCloseTo(-1, 6);
  });

  it('contain: 16:9 dentro de un lienzo vertical entra entero y deja bandas', () => {
    const m = computeFitTransform(base, 1080, 1920);
    const [x, y] = transformCorner(m, 1, 1);
    // Toca los bordes laterales...
    expect(x).toBeCloseTo(1, 6);
    // ...y sobra espacio arriba y abajo. El factor de encaje es 1080/1920 = 0.5625,
    // y el alto que ocupa queda en 0.5625 * 1080 / 1920 del semieje.
    expect(y).toBeCloseTo(0.31640625, 6);
  });

  it('cover: 16:9 dentro de un lienzo vertical llena el alto y desborda a los lados', () => {
    const m = computeFitTransform({ ...base, mode: 'cover' }, 1080, 1920);
    const [x, y] = transformCorner(m, 1, 1);
    expect(y).toBeCloseTo(1, 6); // llena el alto exacto
    expect(x).toBeGreaterThan(1); // y se sale por los costados
    expect(x).toBeCloseTo(1920 / 1080 / (1080 / 1920), 4);
  });

  it('el pan solo corre lo que sobra, y nunca mas que eso', () => {
    const centrado = computeFitTransform({ ...base, mode: 'cover' }, 1080, 1920);
    const corrido = computeFitTransform({ ...base, mode: 'cover', panX: 1 }, 1080, 1920);
    const overflow = transformCorner(centrado, 1, 1)[0] - 1;

    expect(corrido[6]).toBeCloseTo(overflow, 5);
    // Con el pan al maximo, el borde derecho de la imagen queda pegado al borde
    // derecho del lienzo: no se puede correr mas alla del material.
    expect(transformCorner(corrido, -1, 1)[0]).toBeCloseTo(-1, 5);
  });

  it('sin desborde, el pan no hace nada', () => {
    const m = computeFitTransform({ ...base, panX: 1, panY: -1 }, 1920, 1080);
    expect(m[6]).toBeCloseTo(0, 6);
    expect(m[7]).toBeCloseTo(0, 6);
  });

  it('rotacion de 90 grados: la esquina superior derecha va a la inferior derecha', () => {
    const framing: Framing = { ...base, rotation: 90 };
    // Un clip 1920x1080 rotado 90 se presenta como 1080x1920: entra justo en un
    // lienzo vertical.
    const m = computeFitTransform(framing, 1080, 1920);
    const [x, y] = transformCorner(m, 1, 1);
    expect(x).toBeCloseTo(1, 5);
    expect(y).toBeCloseTo(-1, 5);
    const [x2, y2] = transformCorner(m, -1, -1);
    expect(x2).toBeCloseTo(-1, 5);
    expect(y2).toBeCloseTo(1, 5);
  });

  it('rotacion de 180 grados da vuelta la imagen sin cambiar el aspecto', () => {
    const m = computeFitTransform({ ...base, rotation: 180 }, 1920, 1080);
    const [x, y] = transformCorner(m, 1, 1);
    expect(x).toBeCloseTo(-1, 5);
    expect(y).toBeCloseTo(-1, 5);
  });

  it('rotacion de 270 grados tambien entra justo en vertical', () => {
    const m = computeFitTransform({ ...base, rotation: 270 }, 1080, 1920);
    const [x, y] = transformCorner(m, 1, 1);
    expect(x).toBeCloseTo(-1, 5);
    expect(y).toBeCloseTo(1, 5);
  });

  it('rotaciones equivalentes dan la misma matriz', () => {
    const a = computeFitTransform({ ...base, rotation: 450 }, 1080, 1920);
    const b = computeFitTransform({ ...base, rotation: 90 }, 1080, 1920);
    expect(Array.from(a)).toEqual(Array.from(b));
    const c = computeFitTransform({ ...base, rotation: -90 }, 1080, 1920);
    const d = computeFitTransform({ ...base, rotation: 270 }, 1080, 1920);
    expect(Array.from(c)).toEqual(Array.from(d));
  });
});
