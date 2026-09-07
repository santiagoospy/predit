import { describe, expect, it } from 'vitest';

import { decaer, seFreno, velocidadDe } from './deslizar';

describe('velocidadDe', () => {
  it('mide pixeles por milisegundo entre la primera y la ultima muestra', () => {
    expect(
      velocidadDe([
        { x: 0, t: 0 },
        { x: 60, t: 60 },
      ]),
    ).toBeCloseTo(1, 6);
  });

  it('el signo dice para donde iba el dedo', () => {
    expect(
      velocidadDe([
        { x: 100, t: 0 },
        { x: 40, t: 60 },
      ]),
    ).toBeCloseTo(-1, 6);
  });

  it('mira solo el final: frenar antes de soltar deja la tira quieta', () => {
    // Un arrastre largo y rapido que termina parado los ultimos 90ms.
    const muestras = [
      { x: 0, t: 0 },
      { x: 500, t: 500 },
      { x: 502, t: 560 },
      { x: 502, t: 600 },
    ];
    expect(Math.abs(velocidadDe(muestras))).toBeLessThan(0.1);
  });

  it('sin muestras, o con todas en el mismo instante, no hay envion', () => {
    expect(velocidadDe([])).toBe(0);
    expect(velocidadDe([{ x: 10, t: 5 }])).toBe(0);
    expect(
      velocidadDe([
        { x: 0, t: 5 },
        { x: 30, t: 5 },
      ]),
    ).toBe(0);
  });
});

describe('decaer', () => {
  it('afloja la velocidad y devuelve lo que se corrio', () => {
    const { velocidad, avance } = decaer(2, 16);
    expect(avance).toBeCloseTo(32, 6);
    expect(velocidad).toBeLessThan(2);
    expect(velocidad).toBeGreaterThan(1.5);
  });

  it('un paso de cero no mueve ni frena nada', () => {
    expect(decaer(2, 0)).toEqual({ velocidad: 2, avance: 0 });
  });

  it('termina frenando sola', () => {
    let velocidad = 3;
    let vueltas = 0;
    while (!seFreno(velocidad) && vueltas < 1000) {
      velocidad = decaer(velocidad, 16).velocidad;
      vueltas += 1;
    }
    expect(seFreno(velocidad)).toBe(true);
  });
});

describe('seFreno', () => {
  it('corta con la tira casi quieta, y no se cuelga con un NaN', () => {
    expect(seFreno(0)).toBe(true);
    expect(seFreno(0.01)).toBe(true);
    expect(seFreno(1)).toBe(false);
    expect(seFreno(Number.NaN)).toBe(true);
  });
});
