import { describe, expect, it } from 'vitest';
import { formatSeconds, limitarEntrada, limitarSalida, segundosDesdeX, unCuadro } from './trim';

const rect = { left: 100, width: 400 };

describe('segundosDesdeX', () => {
  it('mapea el toque a la posicion proporcional del clip', () => {
    expect(segundosDesdeX(100, rect, 10)).toBeCloseTo(0, 6);
    expect(segundosDesdeX(300, rect, 10)).toBeCloseTo(5, 6);
    expect(segundosDesdeX(500, rect, 10)).toBeCloseTo(10, 6);
  });

  it('el dedo que se va de la barra queda en los extremos, no fuera del clip', () => {
    expect(segundosDesdeX(-40, rect, 10)).toBe(0);
    expect(segundosDesdeX(9999, rect, 10)).toBe(10);
  });

  it('sin ancho o sin duracion devuelve cero en vez de NaN', () => {
    expect(segundosDesdeX(250, { left: 0, width: 0 }, 10)).toBe(0);
    expect(segundosDesdeX(250, rect, 0)).toBe(0);
  });
});

describe('limitarEntrada', () => {
  it('deja pasar un valor comun', () => {
    expect(limitarEntrada(3, 8, 25)).toBe(3);
  });

  it('no deja que la entrada alcance a la salida: queda un cuadro de por medio', () => {
    expect(limitarEntrada(8, 8, 25)).toBeCloseTo(8 - 1 / 25, 6);
    expect(limitarEntrada(20, 8, 25)).toBeCloseTo(8 - 1 / 25, 6);
  });

  it('no se va antes del principio del clip', () => {
    expect(limitarEntrada(-5, 8, 25)).toBe(0);
  });

  it('con la salida pegada al cero, la entrada se queda en cero', () => {
    expect(limitarEntrada(1, 0.01, 25)).toBe(0);
  });
});

describe('limitarSalida', () => {
  it('deja pasar un valor comun', () => {
    expect(limitarSalida(8, 3, 25, 12)).toBe(8);
  });

  it('no deja que la salida alcance a la entrada', () => {
    expect(limitarSalida(3, 3, 25, 12)).toBeCloseTo(3 + 1 / 25, 6);
    expect(limitarSalida(0, 3, 25, 12)).toBeCloseTo(3 + 1 / 25, 6);
  });

  it('no se pasa del final del clip', () => {
    expect(limitarSalida(99, 3, 25, 12)).toBe(12);
  });

  it('con la entrada pegada al final, la salida se queda en el final', () => {
    expect(limitarSalida(99, 12, 25, 12)).toBe(12);
  });
});

describe('ajuste de a un cuadro', () => {
  // Es lo que hacen los botones de flecha: sumar o restar un cuadro y volver a
  // pasar por el limite.
  const moverEntrada = (trimIn: number, cuadros: number, trimOut: number, fps: number) =>
    limitarEntrada(trimIn + cuadros * unCuadro(fps), trimOut, fps);

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
