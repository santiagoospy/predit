import { describe, expect, it } from 'vitest';

import {
  desplazamientoDe,
  destinoDelArrastre,
  moverEnLista,
  offsetDelSlot,
  type Caja,
} from './orden';

/** Cuatro chips de 40px con 6px de separacion, como los de la tira. */
const cajas: Caja[] = [
  { left: 0, width: 40 },
  { left: 46, width: 40 },
  { left: 92, width: 40 },
  { left: 138, width: 40 },
];
const GAP = 6;
const centro = (i: number) => cajas[i]!.left + cajas[i]!.width / 2;

describe('moverEnLista', () => {
  it('corre al resto en vez de intercambiar', () => {
    // El tercero al principio deja 3,1,2: si fuera un intercambio daria 3,2,1.
    expect(moverEnLista([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });

  it('mueve hacia adelante', () => {
    expect(moverEnLista(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('quedarse en el lugar no cambia nada', () => {
    expect(moverEnLista([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
  });

  it('no rompe con indices fuera de la lista', () => {
    expect(moverEnLista([1, 2, 3], 9, 0)).toEqual([1, 2, 3]);
    expect(moverEnLista([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
    expect(moverEnLista([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
  });

  it('devuelve una copia y no toca la lista original', () => {
    const original = [1, 2, 3];
    expect(moverEnLista(original, 0, 2)).not.toBe(original);
    expect(original).toEqual([1, 2, 3]);
  });
});

describe('destinoDelArrastre', () => {
  it('sin mover el dedo, el destino es el lugar propio', () => {
    expect(destinoDelArrastre(centro(2), cajas, 2)).toBe(2);
  });

  it('pasar el centro del vecino de la izquierda lo desplaza', () => {
    expect(destinoDelArrastre(centro(1) - 1, cajas, 2)).toBe(1);
    expect(destinoDelArrastre(centro(0) - 1, cajas, 2)).toBe(0);
  });

  it('pasar el centro del vecino de la derecha lo desplaza', () => {
    expect(destinoDelArrastre(centro(2) + 1, cajas, 1)).toBe(2);
    expect(destinoDelArrastre(centro(3) + 1, cajas, 1)).toBe(3);
  });

  it('quedarse antes del centro del vecino no cambia nada', () => {
    // Medio chip de recorrido todavia no alcanza para pasarlo.
    expect(destinoDelArrastre(centro(2) - 15, cajas, 2)).toBe(2);
  });

  it('el dedo lejos de la tira se queda en los extremos', () => {
    expect(destinoDelArrastre(-9999, cajas, 2)).toBe(0);
    expect(destinoDelArrastre(9999, cajas, 1)).toBe(3);
  });

  it('un indice que no existe se devuelve tal cual, sin romper', () => {
    expect(destinoDelArrastre(50, cajas, 9)).toBe(9);
  });
});

describe('desplazamientoDe', () => {
  it('el chip arrastrado no se corre por esta cuenta', () => {
    expect(desplazamientoDe(2, 2, 0, cajas, GAP)).toBe(0);
  });

  it('yendo a la izquierda, los de en medio se abren hacia la derecha', () => {
    // El 2 va al lugar del 0: el 0 y el 1 se corren un chip a la derecha.
    expect(desplazamientoDe(0, 2, 0, cajas, GAP)).toBe(46);
    expect(desplazamientoDe(1, 2, 0, cajas, GAP)).toBe(46);
    expect(desplazamientoDe(3, 2, 0, cajas, GAP)).toBe(0);
  });

  it('yendo a la derecha, los de en medio se abren hacia la izquierda', () => {
    expect(desplazamientoDe(1, 0, 2, cajas, GAP)).toBe(-46);
    expect(desplazamientoDe(2, 0, 2, cajas, GAP)).toBe(-46);
    expect(desplazamientoDe(3, 0, 2, cajas, GAP)).toBe(0);
  });

  it('sin destino distinto, nadie se mueve', () => {
    expect(desplazamientoDe(0, 1, 1, cajas, GAP)).toBe(0);
    expect(desplazamientoDe(3, 1, 1, cajas, GAP)).toBe(0);
  });
});

describe('offsetDelSlot', () => {
  it('yendo a la izquierda aterriza en el borde izquierdo del que desplaza', () => {
    expect(offsetDelSlot(cajas, 2, 0)).toBe(-92);
  });

  it('yendo a la derecha aterriza alineado por el borde derecho', () => {
    // Del 0 al 2: el borde derecho del 2 esta en 132, y el chip mide 40.
    expect(offsetDelSlot(cajas, 0, 2)).toBe(92);
  });

  it('con anchos distintos usa el ancho de cada caja', () => {
    const mixtas: Caja[] = [
      { left: 0, width: 40 },
      { left: 46, width: 60 },
    ];
    // El 0 mide 40 y va al lugar del 1, que termina en 106: queda en 66.
    expect(offsetDelSlot(mixtas, 0, 1)).toBe(66);
  });

  it('un indice que no existe da cero en vez de NaN', () => {
    expect(offsetDelSlot(cajas, 0, 9)).toBe(0);
  });
});
