/**
 * La matematica de la estabilizacion, con movimientos inventados a proposito.
 *
 * La gracia de estos tests es que el resultado correcto se puede calcular a
 * mano: si la camara gira 10 grados en un segundo, la orientacion integrada
 * tiene que dar 10 grados. Eso atrapa los errores de escala, de signo y de
 * unidades, que son exactamente los que despues se ven como "estabiliza al
 * reves" o "no estabiliza nada".
 */

import { describe, expect, it } from 'vitest';

import {
  integrar,
  orientacionEn,
  prepararEstabilizacion,
  suavizar,
  MAPEO_SONY,
  type Mapeo,
} from './estabilizar';
import { angulo, IDENTIDAD, multiplicar, inverso, slerp, desdeVelocidad, aMatriz } from './quat';
import { focalPxDesdeMm, type MuestraGiro } from './tipos';

/** Un mapeo neutro, para que los tests hablen de ejes y no de fabricantes. */
const DIRECTO: Mapeo = {
  pitch: { de: 'x', signo: 1 },
  yaw: { de: 'y', signo: 1 },
  roll: { de: 'z', signo: 1 },
};

/** Un giro constante en un eje, muestreado a cierta frecuencia. */
function giro(
  gradosPorSegundo: [number, number, number],
  segundos: number,
  hz = 200,
): MuestraGiro[] {
  const muestras: MuestraGiro[] = [];
  const total = Math.round(segundos * hz);
  for (let i = 0; i <= total; i++) {
    muestras.push({
      segundo: i / hz,
      x: gradosPorSegundo[0],
      y: gradosPorSegundo[1],
      z: gradosPorSegundo[2],
    });
  }
  return muestras;
}

const enGrados = (q: Parameters<typeof angulo>[0]) => (angulo(q) * 180) / Math.PI;

describe('integrar', () => {
  it('un giro de 10 grados por segundo durante un segundo da 10 grados', () => {
    const orientaciones = integrar(giro([10, 0, 0], 1), DIRECTO);
    expect(enGrados(orientaciones[orientaciones.length - 1]!.q)).toBeCloseTo(10, 1);
  });

  it('la camara quieta no acumula nada', () => {
    const orientaciones = integrar(giro([0, 0, 0], 2), DIRECTO);
    expect(enGrados(orientaciones[orientaciones.length - 1]!.q)).toBeCloseTo(0, 5);
  });

  it('el signo del mapeo da vuelta el giro', () => {
    const derecho = integrar(giro([10, 0, 0], 1), DIRECTO);
    const invertido = integrar(giro([10, 0, 0], 1), {
      ...DIRECTO,
      pitch: { de: 'x', signo: -1 },
    });
    const ultimoDerecho = derecho[derecho.length - 1]!.q;
    const ultimoInvertido = invertido[invertido.length - 1]!.q;
    // Mismo angulo, sentido opuesto: uno es el inverso del otro.
    expect(enGrados(ultimoDerecho)).toBeCloseTo(enGrados(ultimoInvertido), 4);
    expect(enGrados(multiplicar(ultimoDerecho, ultimoInvertido))).toBeCloseTo(0, 3);
  });

  it('no integra un salto grande en la pista', () => {
    // Dos tramos separados por tres segundos de nada: el hueco no puede
    // convertirse en un giro gigante.
    const muestras: MuestraGiro[] = [
      { segundo: 0, x: 100, y: 0, z: 0 },
      { segundo: 0.01, x: 100, y: 0, z: 0 },
      { segundo: 3, x: 100, y: 0, z: 0 },
      { segundo: 3.01, x: 100, y: 0, z: 0 },
    ];
    const orientaciones = integrar(muestras, DIRECTO);
    // Solo los dos pasos de 0.01s cuentan: 100°/s × 0.02s = 2°.
    expect(enGrados(orientaciones[orientaciones.length - 1]!.q)).toBeLessThan(3);
  });

  it('devuelve una orientacion por medicion', () => {
    const muestras = giro([5, 0, 0], 0.5, 100);
    expect(integrar(muestras, DIRECTO)).toHaveLength(muestras.length);
  });
});

describe('suavizar', () => {
  it('no toca un movimiento perfectamente parejo', () => {
    // Un giro a velocidad constante ya es suave: el filtro solo puede atrasarlo,
    // y como va y vuelve, tiene que devolver casi lo mismo.
    const reales = integrar(giro([10, 0, 0], 2), DIRECTO);
    const suaves = suavizar(reales, 0.3);
    const medio = Math.floor(reales.length / 2);
    const diferencia = multiplicar(suaves[medio]!.q, inverso(reales[medio]!.q));
    expect(enGrados(diferencia)).toBeLessThan(1.5);
  });

  it('borra un temblor rapido', () => {
    // Una vibracion que cambia de signo en cada medicion: es exactamente lo que
    // el filtro tiene que comerse.
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 400; i++) {
      muestras.push({ segundo: i / 200, x: i % 2 === 0 ? 40 : -40, y: 0, z: 0 });
    }
    const reales = integrar(muestras, DIRECTO);
    const suaves = suavizar(reales, 0.5);
    // La orientacion real oscila; la suave tiene que quedar casi quieta.
    let picoReal = 0;
    let picoSuave = 0;
    for (let i = 0; i < reales.length; i++) {
      picoReal = Math.max(picoReal, enGrados(reales[i]!.q));
      picoSuave = Math.max(picoSuave, enGrados(suaves[i]!.q));
    }
    expect(picoSuave).toBeLessThan(picoReal);
  });

  it('con suavidad cero devuelve lo mismo', () => {
    const reales = integrar(giro([10, 0, 0], 1), DIRECTO);
    const suaves = suavizar(reales, 0);
    expect(suaves[10]!.q).toEqual(reales[10]!.q);
  });

  it('no se cae con la lista vacia', () => {
    expect(suavizar([], 0.5)).toEqual([]);
  });
});

describe('orientacionEn', () => {
  const lista = integrar(giro([10, 0, 0], 1, 100), DIRECTO);

  it('interpola entre dos mediciones', () => {
    // A la mitad del segundo la camara giro la mitad de los 10 grados.
    expect(enGrados(orientacionEn(lista, 0.5))).toBeCloseTo(5, 1);
  });

  it('se planta en los extremos en vez de extrapolar', () => {
    expect(orientacionEn(lista, -10)).toEqual(lista[0]!.q);
    expect(orientacionEn(lista, 999)).toEqual(lista[lista.length - 1]!.q);
  });

  it('devuelve identidad si no hay datos', () => {
    expect(orientacionEn([], 1)).toEqual(IDENTIDAD);
  });
});

describe('prepararEstabilizacion', () => {
  const opciones = {
    suavidad: 0.4,
    desfase: 0,
    focalPx: 1000,
    ancho: 1920,
    alto: 1080,
    mapeo: DIRECTO,
  };
  const cuadros = Array.from({ length: 25 }, (_, i) => i / 25);

  it('la camara quieta no necesita ni correccion ni zoom', () => {
    const e = prepararEstabilizacion(giro([0, 0, 0], 1), cuadros, opciones);
    expect(e.zoom).toBe(1);
    expect(e.correccionMaxGrados).toBeCloseTo(0, 3);
    // La matriz tiene que ser la identidad: cada pixel se muestrea donde esta.
    const m = e.matrizEn(0.5);
    expect(m[0]).toBeCloseTo(1, 4);
    expect(m[4]).toBeCloseTo(1, 4);
    expect(m[2]).toBeCloseTo(0, 3);
  });

  it('un temblor obliga a corregir y a recortar', () => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 500; i++) {
      // Una sacudida de un par de grados, ida y vuelta cinco veces por segundo.
      muestras.push({ segundo: i / 500, x: 30 * Math.sin(i / 8), y: 0, z: 0 });
    }
    const e = prepararEstabilizacion(muestras, cuadros, opciones);
    expect(e.correccionMaxGrados).toBeGreaterThan(0.5);
    expect(e.zoom).toBeGreaterThan(1);
  });

  it('el zoom alcanza para que ninguna esquina quede afuera', () => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 500; i++) {
      muestras.push({ segundo: i / 500, x: 40 * Math.sin(i / 10), y: 20 * Math.cos(i / 7), z: 0 });
    }
    const e = prepararEstabilizacion(muestras, cuadros, opciones);

    for (const cuadro of cuadros) {
      const m = e.matrizEn(cuadro);
      for (const [ex, ey] of [
        [0, 0],
        [1920, 0],
        [0, 1080],
        [1920, 1080],
      ]) {
        const w = m[6]! * ex! + m[7]! * ey! + m[8]!;
        const px = (m[0]! * ex! + m[1]! * ey! + m[2]!) / w;
        const py = (m[3]! * ex! + m[4]! * ey! + m[5]!) / w;
        // Con una decima de pixel de tolerancia por la biseccion.
        expect(px).toBeGreaterThanOrEqual(-0.1);
        expect(py).toBeGreaterThanOrEqual(-0.1);
        expect(px).toBeLessThanOrEqual(1920.1);
        expect(py).toBeLessThanOrEqual(1080.1);
      }
    }
  });

  it('el desfase corre la correccion en el tiempo', () => {
    // Un giro que arranca recien a la mitad: con desfase, la correccion en un
    // momento dado tiene que ser distinta.
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 200; i++) {
      muestras.push({ segundo: i / 200, x: i < 100 ? 0 : 60, y: 0, z: 0 });
    }
    const sin = prepararEstabilizacion(muestras, cuadros, opciones);
    const con = prepararEstabilizacion(muestras, cuadros, { ...opciones, desfase: 0.3 });
    expect(sin.matrizEn(0.5)[2]).not.toBeCloseTo(con.matrizEn(0.5)[2]!, 2);
  });

  it('el mapeo de Sony da un resultado, no una explosion', () => {
    const e = prepararEstabilizacion(giro([5, 3, 1], 1), cuadros, {
      ...opciones,
      mapeo: MAPEO_SONY,
    });
    expect(Number.isFinite(e.zoom)).toBe(true);
    expect(Number.isFinite(e.correccionMaxGrados)).toBe(true);
  });

  it('sin mediciones no corrige nada', () => {
    const e = prepararEstabilizacion([], cuadros, opciones);
    expect(e.zoom).toBe(1);
    expect(e.matrizEn(0)[0]).toBeCloseTo(1, 5);
  });
});

describe('quat', () => {
  it('componer una rotacion con su inversa da la identidad', () => {
    const q = desdeVelocidad([0.3, 0.2, 0.1], 1);
    expect(enGrados(multiplicar(q, inverso(q)))).toBeCloseTo(0, 6);
  });

  it('el slerp toma el camino corto aunque los signos no coincidan', () => {
    const a = desdeVelocidad([1, 0, 0], 0.1);
    const b = desdeVelocidad([1, 0, 0], 0.2);
    const opuesto = [-b[0], -b[1], -b[2], -b[3]] as const;
    const porElCorto = slerp(a, b, 0.5);
    const porElOtro = slerp(a, opuesto, 0.5);
    // Dar vuelta el signo no puede cambiar la rotacion resultante.
    expect(enGrados(multiplicar(porElCorto, inverso(porElOtro)))).toBeCloseTo(0, 4);
  });

  it('la matriz de la identidad es la identidad', () => {
    expect(aMatriz(IDENTIDAD)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('la matriz conserva la longitud de un vector', () => {
    const m = aMatriz(desdeVelocidad([0.5, 0.3, 0.2], 1));
    const [x, y, z] = [0.3, -0.7, 0.6];
    const rx = m[0]! * x + m[1]! * y + m[2]! * z;
    const ry = m[3]! * x + m[4]! * y + m[5]! * z;
    const rz = m[6]! * x + m[7]! * y + m[8]! * z;
    expect(Math.hypot(rx, ry, rz)).toBeCloseTo(Math.hypot(x, y, z), 6);
  });
});

describe('focalPxDesdeMm', () => {
  it('el mismo lente en un sensor mas chico da mas focal en pixeles', () => {
    // Un 35mm cubre menos campo en aps-c que en full frame, asi que su focal
    // medida en pixeles de la imagen es mayor.
    const apsc = focalPxDesdeMm(35, 23.5, 3840)!;
    const fullFrame = focalPxDesdeMm(35, 36, 3840)!;
    expect(apsc).toBeGreaterThan(fullFrame);
    expect(apsc / fullFrame).toBeCloseTo(36 / 23.5, 3);
  });

  it('el doble de focal es el doble de pixeles', () => {
    expect(focalPxDesdeMm(100, 36, 1920)!).toBeCloseTo(2 * focalPxDesdeMm(50, 36, 1920)!, 6);
  });

  it('rechaza numeros que no sirven en vez de devolver infinito', () => {
    expect(focalPxDesdeMm(0, 36, 1920)).toBeNull();
    expect(focalPxDesdeMm(35, 0, 1920)).toBeNull();
    expect(focalPxDesdeMm(35, 36, 0)).toBeNull();
  });
});
