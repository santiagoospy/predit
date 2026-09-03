import { describe, expect, it } from 'vitest';
import {
  formatSeconds,
  fraccionEnLaVista,
  limitarEntrada,
  limitarSalida,
  segundosDesdeX,
  unCuadro,
  vistaDeLaBarra,
} from './trim';

const rect = { left: 100, width: 400 };

const todo = (duracion: number) => ({ desde: 0, hasta: duracion });

describe('segundosDesdeX', () => {
  it('mapea el toque a la posicion proporcional del clip', () => {
    expect(segundosDesdeX(100, rect, todo(10))).toBeCloseTo(0, 6);
    expect(segundosDesdeX(300, rect, todo(10))).toBeCloseTo(5, 6);
    expect(segundosDesdeX(500, rect, todo(10))).toBeCloseTo(10, 6);
  });

  it('el dedo que se va de la barra queda en los extremos, no fuera del clip', () => {
    expect(segundosDesdeX(-40, rect, todo(10))).toBe(0);
    expect(segundosDesdeX(9999, rect, todo(10))).toBe(10);
  });

  it('sin ancho o sin duracion devuelve el arranque en vez de NaN', () => {
    expect(segundosDesdeX(250, { left: 0, width: 0 }, todo(10))).toBe(0);
    expect(segundosDesdeX(250, rect, todo(0))).toBe(0);
  });

  it('con la barra estirada a un tramo, el ancho entero es ese tramo', () => {
    const vista = { desde: 4, hasta: 8 };
    expect(segundosDesdeX(100, rect, vista)).toBeCloseTo(4, 6);
    expect(segundosDesdeX(300, rect, vista)).toBeCloseTo(6, 6);
    expect(segundosDesdeX(500, rect, vista)).toBeCloseTo(8, 6);
  });
});

describe('vistaDeLaBarra', () => {
  it('estira la barra al corte, con aire a los costados para agarrar las manijas', () => {
    // Corte de 10s dentro de un clip de 100s: 1.5s de aire a cada lado.
    const vista = vistaDeLaBarra(40, 50, 100);
    expect(vista.desde).toBeCloseTo(38.5, 6);
    expect(vista.hasta).toBeCloseTo(51.5, 6);
  });

  it('el aire no se sale del clip', () => {
    expect(vistaDeLaBarra(0, 10, 100)).toEqual({ desde: 0, hasta: 11.5 });
    expect(vistaDeLaBarra(90, 100, 100)).toEqual({ desde: 88.5, hasta: 100 });
  });

  it('si el corte cubre casi todo el clip, muestra el clip entero', () => {
    // Sin esto la barra se correria un 2% y el cabezal saltaria por nada.
    expect(vistaDeLaBarra(1, 99, 100)).toEqual({ desde: 0, hasta: 100 });
  });

  it('sin clip o con el corte al reves devuelve el clip entero, no un rango vacio', () => {
    expect(vistaDeLaBarra(0, 0, 0)).toEqual({ desde: 0, hasta: 0 });
    expect(vistaDeLaBarra(8, 3, 10)).toEqual({ desde: 0, hasta: 10 });
  });
});

describe('fraccionEnLaVista', () => {
  it('ubica un segundo dentro del tramo dibujado', () => {
    expect(fraccionEnLaVista(6, { desde: 4, hasta: 8 })).toBeCloseTo(0.5, 6);
  });

  it('lo que cae fuera del tramo se pega a los bordes', () => {
    expect(fraccionEnLaVista(0, { desde: 4, hasta: 8 })).toBe(0);
    expect(fraccionEnLaVista(99, { desde: 4, hasta: 8 })).toBe(1);
  });

  it('un tramo de largo cero no da NaN', () => {
    expect(fraccionEnLaVista(5, { desde: 5, hasta: 5 })).toBe(0);
  });
});

describe('limitarEntrada', () => {
  it('deja pasar un valor comun', () => {
    expect(limitarEntrada(3, 8, unCuadro(25))).toBe(3);
  });

  it('no deja que la entrada alcance a la salida: queda un cuadro de por medio', () => {
    expect(limitarEntrada(8, 8, unCuadro(25))).toBeCloseTo(8 - 1 / 25, 6);
    expect(limitarEntrada(20, 8, unCuadro(25))).toBeCloseTo(8 - 1 / 25, 6);
  });

  it('no se va antes del principio del clip', () => {
    expect(limitarEntrada(-5, 8, unCuadro(25))).toBe(0);
  });

  it('con la salida pegada al cero, la entrada se queda en cero', () => {
    expect(limitarEntrada(1, 0.01, unCuadro(25))).toBe(0);
  });
});

describe('limitarSalida', () => {
  it('deja pasar un valor comun', () => {
    expect(limitarSalida(8, 3, unCuadro(25), 12)).toBe(8);
  });

  it('no deja que la salida alcance a la entrada', () => {
    expect(limitarSalida(3, 3, unCuadro(25), 12)).toBeCloseTo(3 + 1 / 25, 6);
    expect(limitarSalida(0, 3, unCuadro(25), 12)).toBeCloseTo(3 + 1 / 25, 6);
  });

  it('no se pasa del final del clip', () => {
    expect(limitarSalida(99, 3, unCuadro(25), 12)).toBe(12);
  });

  it('con la entrada pegada al final, la salida se queda en el final', () => {
    expect(limitarSalida(99, 12, unCuadro(25), 12)).toBe(12);
  });
});

describe('ajuste de a un cuadro', () => {
  // Es lo que hacen los botones de flecha: sumar o restar un cuadro y volver a
  // pasar por el limite.
  const moverEntrada = (trimIn: number, cuadros: number, trimOut: number, fps: number) =>
    limitarEntrada(trimIn + cuadros * unCuadro(fps), trimOut, unCuadro(fps));

  it('un cuadro adelante y uno atras vuelven al mismo lugar', () => {
    const ida = moverEntrada(3, 1, 8, 50);
    expect(moverEntrada(ida, -1, 8, 50)).toBeCloseTo(3, 6);
  });

  it('contra el principio del clip se frena, no se pasa', () => {
    expect(moverEntrada(0, -1, 8, 50)).toBe(0);
  });

  it('contra la otra manija se frena a un cuadro de distancia', () => {
    const pegada = 8 - 1 / 50;
    expect(moverEntrada(pegada, 1, 8, 50)).toBeCloseTo(pegada, 6);
  });

  it('el cuadro depende de los fps del archivo', () => {
    expect(unCuadro(50)).toBeCloseTo(0.02, 6);
    expect(unCuadro(25)).toBeCloseTo(0.04, 6);
  });

  it('un fps invalido cae en 25 en vez de dar Infinity', () => {
    expect(unCuadro(0)).toBeCloseTo(0.04, 6);
    expect(unCuadro(Number.NaN)).toBeCloseTo(0.04, 6);
  });

  it('el paso va en segundos, asi la musica puede cortar de a decimas', () => {
    // La barra de musica usa 0.1: no tiene cuadros, pero el limite es el mismo.
    expect(limitarEntrada(8, 8, 0.1)).toBeCloseTo(7.9, 6);
    expect(limitarSalida(3, 3, 0.1, 12)).toBeCloseTo(3.1, 6);
  });
});

describe('formatSeconds', () => {
  it('muestra las decimas, que es lo que formatDuration se comia', () => {
    expect(formatSeconds(4.4)).toBe('0:04.4');
    expect(formatSeconds(4.6)).toBe('0:04.6');
  });

  it('separa minutos y rellena los segundos', () => {
    expect(formatSeconds(0)).toBe('0:00.0');
    expect(formatSeconds(9.05)).toBe('0:09.1');
    expect(formatSeconds(65.4)).toBe('1:05.4');
    expect(formatSeconds(600)).toBe('10:00.0');
  });

  it('al redondear hacia arriba pasa de minuto en vez de mostrar 0:60.0', () => {
    expect(formatSeconds(59.99)).toBe('1:00.0');
  });

  it('un negativo se lee como cero', () => {
    expect(formatSeconds(-3)).toBe('0:00.0');
  });
});
