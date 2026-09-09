import { describe, expect, it } from 'vitest';

import { colorDeClip, varClipDe } from './colorClip';

describe('colorDeClip', () => {
  it('devuelve siempre un numero de 1 a 6', () => {
    const ids = ['a', 'clip-42', 'C0001.MP4', '', 'ñ', 'un-id-bastante-largo-de-verdad'];
    for (const id of ids) {
      const color = colorDeClip(id);
      expect(color).toBeGreaterThanOrEqual(1);
      expect(color).toBeLessThanOrEqual(6);
    }
  });

  it('es estable: el mismo id siempre da el mismo color', () => {
    expect(colorDeClip('clip-7')).toBe(colorDeClip('clip-7'));
  });

  it('no depende de la posicion, solo del id', () => {
    // Reordenar la tira no cambia el id de cada clip, asi que su color tampoco.
    const idsEnOrdenA = ['x', 'y', 'z'];
    const idsEnOrdenB = ['z', 'x', 'y'];
    const colorDe = (lista: string[], id: string) => lista.indexOf(id) >= 0 && colorDeClip(id);
    expect(colorDe(idsEnOrdenA, 'x')).toBe(colorDe(idsEnOrdenB, 'x'));
  });
});

describe('varClipDe', () => {
  it('arma la referencia al token que corresponde', () => {
    const id = 'clip-1';
    expect(varClipDe(id)).toBe(`var(--clip-${colorDeClip(id)})`);
  });
});
