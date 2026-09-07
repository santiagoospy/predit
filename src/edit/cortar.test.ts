import { describe, expect, it } from 'vitest';

import { partir } from './cortar';

const clip = { trimIn: 2, trimOut: 10 };
const paso = 1 / 25;

describe('partir', () => {
  it('corta al medio y los dos pedazos se tocan en el mismo segundo', () => {
    const corte = partir(clip, 6, paso);
    expect(corte).toEqual({ izquierda: 6, derecha: 6 });
  });

  it('los dos tramos suman el material original', () => {
    const corte = partir(clip, 6.4, paso)!;
    const izquierda = corte.izquierda - clip.trimIn;
    const derecha = clip.trimOut - corte.derecha;
    expect(izquierda + derecha).toBeCloseTo(clip.trimOut - clip.trimIn, 6);
  });

  it('no corta pegado a la entrada ni a la salida: quedaria un clip de cero cuadros', () => {
    expect(partir(clip, clip.trimIn, paso)).toBeNull();
    expect(partir(clip, clip.trimIn + paso / 2, paso)).toBeNull();
    expect(partir(clip, clip.trimOut, paso)).toBeNull();
    expect(partir(clip, clip.trimOut - paso / 2, paso)).toBeNull();
  });

  it('a exactamente un cuadro de cada punta si corta', () => {
    expect(partir(clip, clip.trimIn + paso, paso)).not.toBeNull();
    expect(partir(clip, clip.trimOut - paso, paso)).not.toBeNull();
  });

  it('no corta fuera del recorte, aunque el segundo exista en el archivo', () => {
    expect(partir(clip, 0, paso)).toBeNull();
    expect(partir(clip, 20, paso)).toBeNull();
  });

  it('sin paso valido no corta en vez de devolver marcas rotas', () => {
    expect(partir(clip, 6, 0)).toBeNull();
    expect(partir(clip, Number.NaN, paso)).toBeNull();
  });
});
