import { describe, expect, it } from 'vitest';
import { capaEnSegundo, capaVisibleEn, framingDeCapa, tiempoEnLaLinea } from './types';

const tramo = { startSeconds: 2, endSeconds: 5 };

describe('capaVisibleEn', () => {
  it('se ve dentro del tramo', () => {
    expect(capaVisibleEn(tramo, 3.5)).toBe(true);
  });

  it('no se ve ni antes ni despues', () => {
    expect(capaVisibleEn(tramo, 1.9)).toBe(false);
    expect(capaVisibleEn(tramo, 5.1)).toBe(false);
  });

  it('la entrada es inclusiva y la salida exclusiva, como el recorte de un clip', () => {
    expect(capaVisibleEn(tramo, 2)).toBe(true);
    expect(capaVisibleEn(tramo, 5)).toBe(false);
  });

  it('dos tramos pegados no comparten ningun instante', () => {
    const a = { startSeconds: 0, endSeconds: 2 };
    const b = { startSeconds: 2, endSeconds: 4 };
    expect(capaVisibleEn(a, 2)).toBe(false);
    expect(capaVisibleEn(b, 2)).toBe(true);
  });

  it('un tramo vacio no se ve nunca', () => {
    expect(capaVisibleEn({ startSeconds: 3, endSeconds: 3 }, 3)).toBe(false);
  });
});

describe('tiempoEnLaLinea', () => {
  it('el primer clip sin recorte da el tiempo del video tal cual', () => {
    expect(tiempoEnLaLinea(0, 4, 0, 1)).toBeCloseTo(4, 6);
  });

  it('descuenta la marca de entrada y suma lo que duran los clips anteriores', () => {
    // El clip arranca en el segundo 10 del montaje y esta recortado desde 3.
    expect(tiempoEnLaLinea(10, 4.5, 3, 1)).toBeCloseTo(11.5, 6);
  });

  it('la camara lenta estira lo que va corrido dentro del clip', () => {
    // A media velocidad, 2 segundos de material ocupan 4 en el montaje.
    expect(tiempoEnLaLinea(0, 2, 0, 0.5)).toBeCloseTo(4, 6);
    expect(tiempoEnLaLinea(6, 5, 3, 0.5)).toBeCloseTo(10, 6);
  });

  it('en la marca de entrada cae justo donde arranca el clip', () => {
    expect(tiempoEnLaLinea(7, 3, 3, 2)).toBeCloseTo(7, 6);
  });

  it('una velocidad de cero no devuelve infinito', () => {
    expect(tiempoEnLaLinea(0, 2, 0, 0)).toBeCloseTo(2, 6);
  });
});

describe('framingDeCapa', () => {
  const capa = { width: 800, height: 400, scale: 1, offsetX: 0, offsetY: 0 };

  it('usa contain, para que escala 1 sea "entra justo entera"', () => {
    expect(framingDeCapa(capa).mode).toBe('contain');
  });

  it('no rota: una imagen no trae rotacion en metadatos como un video', () => {
    expect(framingDeCapa(capa).rotation).toBe(0);
  });

  it('pasa la escala y el desplazamiento tal cual, sin convertir a pixeles', () => {
    const f = framingDeCapa({ ...capa, scale: 0.25, offsetX: -0.5, offsetY: 0.75 });
    expect(f.scale).toBe(0.25);
    expect(f.offsetX).toBe(-0.5);
    expect(f.offsetY).toBe(0.75);
  });

  it('no usa pan: el desplazamiento de una capa es libre, no limitado por el sobrante', () => {
    const f = framingDeCapa(capa);
    expect(f.panX).toBeUndefined();
    expect(f.panY).toBeUndefined();
  });
});

/**
 * La animacion de la capa es matematica pura, asi que se puede verificar entera
 * sin GPU: es la parte de la feature que queda probada de verdad.
 */
const quieta = {
  startSeconds: 0,
  endSeconds: 10,
  scale: 0.5,
  opacity: 0.8,
  entradaSeconds: 0,
  salidaSeconds: 0,
  scaleEntrada: 1,
  scaleSalida: 1,
};

describe('capaEnSegundo', () => {
  it('sin entrada ni salida, la capa no se mueve nunca', () => {
    for (const t of [0, 2.5, 5, 9.99]) {
      expect(capaEnSegundo(quieta, t)).toEqual({ scale: 0.5, opacity: 0.8 });
    }
  });

  it('en el medio queda en reposo, aunque haya entrada y salida', () => {
    const capa = { ...quieta, entradaSeconds: 1, salidaSeconds: 1, scaleEntrada: 0.5 };
    expect(capaEnSegundo(capa, 5)).toEqual({ scale: 0.5, opacity: 0.8 });
  });

  it('arranca invisible y termina invisible', () => {
    const capa = { ...quieta, entradaSeconds: 2, salidaSeconds: 2 };
    expect(capaEnSegundo(capa, 0).opacity).toBeCloseTo(0, 6);
    // Justo en el ultimo instante del tramo ya se fue del todo.
    expect(capaEnSegundo(capa, 10).opacity).toBeCloseTo(0, 6);
  });

  it('la opacidad crece durante la entrada y baja durante la salida', () => {
    const capa = { ...quieta, entradaSeconds: 2, salidaSeconds: 2 };
    const subiendo = [0, 0.5, 1, 1.5].map((t) => capaEnSegundo(capa, t).opacity);
    const bajando = [8.5, 9, 9.5].map((t) => capaEnSegundo(capa, t).opacity);
    for (let i = 1; i < subiendo.length; i++) {
      expect(subiendo[i]!).toBeGreaterThan(subiendo[i - 1]!);
    }
    for (let i = 1; i < bajando.length; i++) {
      expect(bajando[i]!).toBeLessThan(bajando[i - 1]!);
    }
  });

  it('la opacidad nunca pasa la de reposo', () => {
    const capa = { ...quieta, entradaSeconds: 2, salidaSeconds: 2 };
    for (let t = 0; t <= 10; t += 0.25) {
      expect(capaEnSegundo(capa, t).opacity).toBeLessThanOrEqual(0.8 + 1e-9);
    }
  });

  it('a mitad de la entrada, la curva suave esta justo en la mitad', () => {
    // smoothstep(0.5) = 0.5: es el unico punto donde coincide con la lineal.
    const capa = { ...quieta, entradaSeconds: 2 };
    expect(capaEnSegundo(capa, 1).opacity).toBeCloseTo(0.4, 6);
  });

  it('la curva es suave: al principio avanza menos que una recta', () => {
    const capa = { ...quieta, entradaSeconds: 2 };
    // A un cuarto de la entrada, una recta daria 0.25 del valor; la suave, menos.
    const suave = capaEnSegundo(capa, 0.5).opacity / 0.8;
    expect(suave).toBeLessThan(0.25);
    expect(suave).toBeGreaterThan(0);
  });

  it('entra creciendo desde la escala pedida hasta la de reposo', () => {
    const capa = { ...quieta, entradaSeconds: 2, scaleEntrada: 0.5 };
    // Al principio, la mitad de la escala de reposo.
    expect(capaEnSegundo(capa, 0).scale).toBeCloseTo(0.25, 6);
    // Ya en reposo, la escala tal cual.
    expect(capaEnSegundo(capa, 3).scale).toBeCloseTo(0.5, 6);
  });

  it('sale hacia la escala pedida, que puede ser distinta de la de entrada', () => {
    const capa = { ...quieta, entradaSeconds: 2, salidaSeconds: 2, scaleEntrada: 0.5, scaleSalida: 2 };
    expect(capaEnSegundo(capa, 0).scale).toBeCloseTo(0.25, 6);
    expect(capaEnSegundo(capa, 10).scale).toBeCloseTo(1, 6);
  });

  it('con escala 1 en las puntas solo se mueve la opacidad', () => {
    const capa = { ...quieta, entradaSeconds: 2, salidaSeconds: 2 };
    for (const t of [0, 1, 5, 9, 10]) {
      expect(capaEnSegundo(capa, t).scale).toBeCloseTo(0.5, 6);
    }
  });

  it('si la entrada y la salida no entran en el tramo, se achican en proporcion', () => {
    // Tramo de 2s con 3s de entrada y 1s de salida: se reparten como 1.5 y 0.5.
    const capa = { ...quieta, endSeconds: 2, entradaSeconds: 3, salidaSeconds: 1 };
    // En el punto donde se tocan las dos, la capa llega a su reposo.
    expect(capaEnSegundo(capa, 1.5).opacity).toBeCloseTo(0.8, 6);
    expect(capaEnSegundo(capa, 0).opacity).toBeCloseTo(0, 6);
    expect(capaEnSegundo(capa, 2).opacity).toBeCloseTo(0, 6);
  });

  it('un tramo vacio devuelve el reposo en vez de dividir por cero', () => {
    const capa = { ...quieta, startSeconds: 3, endSeconds: 3, entradaSeconds: 1 };
    const r = capaEnSegundo(capa, 3);
    expect(Number.isFinite(r.scale)).toBe(true);
    expect(Number.isFinite(r.opacity)).toBe(true);
    expect(r).toEqual({ scale: 0.5, opacity: 0.8 });
  });

  it('tiempos negativos no rompen nada', () => {
    const capa = { ...quieta, entradaSeconds: -1, salidaSeconds: -1 };
    expect(capaEnSegundo(capa, 5)).toEqual({ scale: 0.5, opacity: 0.8 });
  });
});
