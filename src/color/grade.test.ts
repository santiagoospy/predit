import { describe, expect, it } from 'vitest';

import { applyGrade, esNeutro, GRADE_NEUTRO, LIMITES, sanearGrade, type Grade } from './grade';

const g = (extra: Partial<Grade> = {}): Grade => ({ ...GRADE_NEUTRO, ...extra });

/** Aplica el grade a un valor gris, que es donde se lee mas facil la cuenta. */
const gris = (v: number, grade: Grade): number => applyGrade([v, v, v], grade)[0];

describe('applyGrade', () => {
  it('en neutro devuelve el color intacto', () => {
    for (const v of [0, 0.18, 0.5, 0.9, 1]) {
      expect(gris(v, GRADE_NEUTRO)).toBeCloseTo(v, 6);
    }
  });

  it('trata los tres canales por separado', () => {
    const [r, verde, b] = applyGrade([0, 0.5, 1], g({ gain: 2 }));
    expect(r).toBeCloseTo(0, 6);
    expect(verde).toBeCloseTo(1, 6);
    expect(b).toBeCloseTo(2, 6);
  });

  it('el lift levanta el negro y deja el blanco quieto', () => {
    const grade = g({ lift: 0.1 });
    expect(gris(0, grade)).toBeCloseTo(0.1, 6);
    expect(gris(1, grade)).toBeCloseTo(1, 6);
    // El medio se mueve, pero menos que el negro: el lift esta pivotado en el blanco.
    expect(gris(0.5, grade)).toBeCloseTo(0.55, 6);
  });

  it('el lift negativo hunde el negro sin devolver NaN', () => {
    // Sin el max(v, 0) previo al pow, esto seria NaN y en la GPU basura en pantalla.
    const salida = gris(0, g({ lift: -0.3, gamma: 2 }));
    expect(Number.isNaN(salida)).toBe(false);
    expect(salida).toBe(0);
  });

  it('el gain multiplica', () => {
    expect(gris(0.4, g({ gain: 1.5 }))).toBeCloseTo(0.6, 6);
    expect(gris(0, g({ gain: 1.5 }))).toBeCloseTo(0, 6);
  });

  it('el gamma mueve los medios y deja los extremos clavados', () => {
    const grade = g({ gamma: 2 });
    expect(gris(0, grade)).toBeCloseTo(0, 6);
    expect(gris(1, grade)).toBeCloseTo(1, 6);
    expect(gris(0.25, grade)).toBeCloseTo(0.5, 6);
    // gamma > 1 aclara los medios.
    expect(gris(0.5, grade)).toBeGreaterThan(0.5);
  });

  it('aplica en orden lift, gamma y despues gain', () => {
    const grade = g({ lift: 0.1, gamma: 2, gain: 1.5 });
    // 0.36 -> lift: 0.36 + 0.1*0.64 = 0.424 -> gamma: sqrt(0.424) -> gain: *1.5
    const esperado = Math.sqrt(0.424) * 1.5;
    expect(gris(0.36, grade)).toBeCloseTo(esperado, 6);
  });

  it('no acota las luces: eso lo hace despues el dominio del LUT', () => {
    expect(gris(1, g({ gain: 2 }))).toBeCloseTo(2, 6);
  });
});

describe('esNeutro', () => {
  it('reconoce el neutro y cualquier desvio', () => {
    expect(esNeutro(GRADE_NEUTRO)).toBe(true);
    expect(esNeutro(g({ lift: 0.01 }))).toBe(false);
    expect(esNeutro(g({ gamma: 0.99 }))).toBe(false);
    expect(esNeutro(g({ gain: 1.01 }))).toBe(false);
  });
});

describe('sanearGrade', () => {
  it('un clip guardado sin estos campos entra en neutro', () => {
    expect(sanearGrade(undefined)).toEqual(GRADE_NEUTRO);
    expect(sanearGrade({})).toEqual(GRADE_NEUTRO);
  });

  it('completa solo lo que falta', () => {
    expect(sanearGrade({ gain: 1.4 })).toEqual({ lift: 0, gamma: 1, gain: 1.4 });
  });

  it('acota lo que se fue de rango', () => {
    expect(sanearGrade({ lift: 9, gamma: -5, gain: 99 })).toEqual({
      lift: LIMITES.lift.max,
      gamma: LIMITES.gamma.min,
      gain: LIMITES.gain.max,
    });
  });

  it('descarta basura que no es un numero utilizable', () => {
    const roto = { lift: NaN, gamma: 'mucho', gain: null } as unknown as Partial<Grade>;
    expect(sanearGrade(roto)).toEqual(GRADE_NEUTRO);
  });
});
