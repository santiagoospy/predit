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
  mapeoDesdeOrientacion,
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
    zoomMaximo: 4,
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

describe('mapeoDesdeOrientacion', () => {
  it('lee la cadena que declara la camara', () => {
    // "XYZ": cada canal va a su eje homonimo, todos positivos.
    expect(mapeoDesdeOrientacion('XYZ')).toEqual({
      pitch: { de: 'x', signo: 1 },
      yaw: { de: 'y', signo: 1 },
      roll: { de: 'z', signo: 1 },
    });
  });

  it('la minuscula invierte el eje', () => {
    expect(mapeoDesdeOrientacion('XYz')?.roll).toEqual({ de: 'z', signo: -1 });
  });

  it('cada letra dice de que canal sale el eje de ESA posicion', () => {
    // "ZXY", que es lo que declara GoPro: el eje X sale del canal z, el eje Y
    // del canal x y el eje Z del canal y. Leerlo al reves da la permutacion
    // inversa, que cruza los tres ejes.
    const mapeo = mapeoDesdeOrientacion('ZXY')!;
    expect(mapeo.pitch).toEqual({ de: 'z', signo: 1 });
    expect(mapeo.yaw).toEqual({ de: 'x', signo: 1 });
    expect(mapeo.roll).toEqual({ de: 'y', signo: 1 });
  });

  it('no es lo mismo leerla al reves', () => {
    // La garantia de que no se vuelva a colar la lectura invertida: una cadena
    // ciclica y su inversa tienen que dar mapeos distintos.
    expect(mapeoDesdeOrientacion('ZXY')).not.toEqual(mapeoDesdeOrientacion('YZX'));
  });

  it('el mapeo leido produce la misma rotacion que armarlo a mano', () => {
    const muestras = giro([7, 0, 0], 1);
    const leido = integrar(muestras, mapeoDesdeOrientacion('XYZ')!);
    const aMano = integrar(muestras, DIRECTO);
    expect(enGrados(leido[leido.length - 1]!.q)).toBeCloseTo(
      enGrados(aMano[aMano.length - 1]!.q),
      6,
    );
  });

  it('rechaza una cadena que no describe tres ejes distintos', () => {
    expect(mapeoDesdeOrientacion('XXY')).toBeNull();
    expect(mapeoDesdeOrientacion('XY')).toBeNull();
    expect(mapeoDesdeOrientacion('ABC')).toBeNull();
  });
});

describe('matrizUvEn', () => {
  const opciones = {
    suavidad: 0.4,
    desfase: 0,
    focalPx: 1200,
    ancho: 1920,
    alto: 1080,
    mapeo: DIRECTO,
    zoomMaximo: 4,
  };
  const cuadros = Array.from({ length: 10 }, (_, i) => i / 10);

  const temblor = () => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 400; i++) {
      muestras.push({ segundo: i / 400, x: 25 * Math.sin(i / 9), y: 15 * Math.cos(i / 6), z: 5 });
    }
    return muestras;
  };

  /** Aplica una matriz 3x3 por filas a un punto, con division de perspectiva. */
  const aplicar = (m: number[], x: number, y: number) => {
    const w = m[6]! * x + m[7]! * y + m[8]!;
    return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w] as const;
  };

  it('da el mismo punto que la matriz en pixeles', () => {
    const e = prepararEstabilizacion(temblor(), cuadros, opciones);
    const enPx = e.matrizEn(0.37);
    const enUv = e.matrizUvEn(0.37);

    // Varios puntos repartidos, no solo el centro: un error de escala en un eje
    // se esconde justo en el medio de la imagen.
    for (const [ux, uy] of [
      [0.5, 0.5],
      [0, 0],
      [1, 1],
      [0.25, 0.8],
    ]) {
      const [px, py] = aplicar(enPx, ux! * opciones.ancho, uy! * opciones.alto);
      const [vx, vy] = aplicar(enUv, ux!, uy!);
      expect(vx).toBeCloseTo(px / opciones.ancho, 9);
      expect(vy).toBeCloseTo(py / opciones.alto, 9);
    }
  });

  it('la camara quieta deja el uv como estaba', () => {
    const e = prepararEstabilizacion(giro([0, 0, 0], 1), cuadros, opciones);
    const [vx, vy] = aplicar(e.matrizUvEn(0.5), 0.3, 0.7);
    expect(vx).toBeCloseTo(0.3, 6);
    expect(vy).toBeCloseTo(0.7, 6);
  });

  it('todo el cuadro cae adentro de la textura', () => {
    const e = prepararEstabilizacion(temblor(), cuadros, opciones);
    for (const cuadro of cuadros) {
      const m = e.matrizUvEn(cuadro);
      for (const [ux, uy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const [vx, vy] = aplicar(m, ux!, uy!);
        expect(vx).toBeGreaterThanOrEqual(-1e-4);
        expect(vy).toBeGreaterThanOrEqual(-1e-4);
        expect(vx).toBeLessThanOrEqual(1 + 1e-4);
        expect(vy).toBeLessThanOrEqual(1 + 1e-4);
      }
    }
  });
});

/**
 * El test que le faltaba a todo esto: que la correccion vaya para el LADO
 * correcto.
 *
 * Los tests anteriores comprobaban que la matriz fuera coherente consigo misma
 * -que las esquinas entraran, que el uv coincidiera con los pixeles- y eso se
 * cumple igual con la correccion invertida. El sintoma en pantalla era que el
 * clip temblaba el DOBLE, y ningun test lo veia.
 *
 * La idea aca es mirar el mundo: se fija un punto lejano, se mira en que
 * direccion lo ve el pixel del centro cuadro a cuadro, y se mide cuanto se
 * mueve esa direccion. Estabilizar tiene que ACHICAR ese movimiento.
 */
describe('la correccion va en la direccion correcta', () => {
  const opciones = {
    suavidad: 1,
    desfase: 0,
    focalPx: 1400,
    ancho: 1920,
    alto: 1080,
    mapeo: DIRECTO,
    zoomMaximo: 4,
  };

  /** Un temblor de mano: rapido, chico y sin ir a ningun lado. */
  const temblor = (): MuestraGiro[] => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 600; i++) {
      const t = i / 300;
      muestras.push({
        segundo: t,
        x: 20 * Math.sin(t * 34),
        y: 16 * Math.sin(t * 27 + 1),
        z: 0,
      });
    }
    return muestras;
  };

  /**
   * Hacia donde mira, en el mundo, el pixel del centro de la salida.
   *
   * Se toma el rayo del centro, se lo pasa por la matriz de muestreo para saber
   * que pixel de la imagen real ocupa, y se lo devuelve al mundo con la
   * orientacion real de la camara en ese instante.
   */
  const dondeMiraElCentro = (m: number[], qReal: Parameters<typeof aMatriz>[0]) => {
    const cx = opciones.ancho / 2;
    const cy = opciones.alto / 2;
    const w = m[6]! * cx + m[7]! * cy + m[8]!;
    const px = (m[0]! * cx + m[1]! * cy + m[2]!) / w;
    const py = (m[3]! * cx + m[4]! * cy + m[5]!) / w;

    // De pixel a rayo en la camara, y de ahi al mundo.
    const v = [(px - cx) / opciones.focalPx, (py - cy) / opciones.focalPx, 1];
    const r = aMatriz(qReal);
    const d = [
      r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!,
      r[3]! * v[0]! + r[4]! * v[1]! + r[5]! * v[2]!,
      r[6]! * v[0]! + r[7]! * v[1]! + r[8]! * v[2]!,
    ];
    const n = Math.hypot(d[0]!, d[1]!, d[2]!);
    return [d[0]! / n, d[1]! / n, d[2]! / n] as const;
  };

  /** Cuanto se abre el abanico de direcciones, en grados. */
  const dispersion = (direcciones: (readonly [number, number, number])[]) => {
    let peor = 0;
    for (const a of direcciones) {
      for (const b of direcciones) {
        const coseno = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
        peor = Math.max(peor, (Math.acos(coseno) * 180) / Math.PI);
      }
    }
    return peor;
  };

  it('estabilizar achica el movimiento, no lo agranda', () => {
    const muestras = temblor();
    const cuadros = Array.from({ length: 40 }, (_, i) => 0.4 + (i / 40) * 1.2);
    const e = prepararEstabilizacion(muestras, cuadros, opciones);
    const reales = integrar(muestras, DIRECTO);

    const identidad = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const sinEstabilizar = cuadros.map((t) =>
      dondeMiraElCentro(identidad, orientacionEn(reales, t)),
    );
    const estabilizado = cuadros.map((t) =>
      dondeMiraElCentro(e.matrizEn(t), orientacionEn(reales, t)),
    );

    const antes = dispersion(sinEstabilizar);
    const despues = dispersion(estabilizado);

    // Que se mueva de verdad, si no el test no prueba nada.
    expect(antes).toBeGreaterThan(1);
    // Y que estabilizar lo reduzca de forma clara. Con la correccion invertida
    // este numero sale del orden del DOBLE de `antes`, que es justo el sintoma
    // que se veia en pantalla.
    expect(despues).toBeLessThan(antes * 0.5);
  });
});

/**
 * Que pasa cuando el temblor pide mas recorte del que hay disponible.
 *
 * Es el caso normal en material muy movido, y la forma de resolverlo decide si
 * la funcion sirve o no: acotando cuadro por cuadro, la correccion se satura
 * contra el tope y deja de estabilizar -y encima se ve igual con cualquier
 * ajuste, porque el tope tapa las diferencias-.
 */
describe('cuando el recorte no alcanza', () => {
  const base = {
    suavidad: 1,
    desfase: 0,
    focalPx: 554,
    ancho: 1920,
    alto: 1080,
    mapeo: DIRECTO,
    zoomMaximo: 4,
  };
  const cuadros = Array.from({ length: 60 }, (_, i) => 0.5 + (i / 60) * 2);

  /** Un temblor fuerte, del orden del de una camara caminando. */
  const fuerte = (): MuestraGiro[] => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 600; i++) {
      const t = i / 200;
      muestras.push({ segundo: t, x: 60 * Math.sin(t * 12.6), y: 45 * Math.sin(t * 11.1 + 1), z: 0 });
    }
    return muestras;
  };

  it('avisa que esta corrigiendo de menos', () => {
    const holgado = prepararEstabilizacion(fuerte(), cuadros, base);
    const apretado = prepararEstabilizacion(fuerte(), cuadros, { ...base, zoomMaximo: 1.1 });

    expect(holgado.ganancia).toBe(1);
    expect(apretado.ganancia).toBeLessThan(1);
    expect(apretado.zoomIdeal).toBeGreaterThan(apretado.zoom);
  });

  it('la correccion sigue siendo proporcional al temblor, no saturada', () => {
    // La prueba de que conserva la forma: con MAS suavidad la correccion tiene
    // que ser mas grande, aun con el recorte topeado. Acotando cuadro a cuadro
    // los dos daban exactamente lo mismo, que era el sintoma en pantalla.
    const opciones = { ...base, zoomMaximo: 1.15 };
    const desplaza = (suavidad: number) => {
      const e = prepararEstabilizacion(fuerte(), cuadros, { ...opciones, suavidad });
      let peor = 0;
      for (const t of cuadros) {
        const m = e.matrizEn(t);
        const cx = base.ancho / 2;
        const cy = base.alto / 2;
        const w = m[6]! * cx + m[7]! * cy + m[8]!;
        peor = Math.max(
          peor,
          Math.hypot(
            (m[0]! * cx + m[1]! * cy + m[2]!) / w - cx,
            (m[3]! * cx + m[4]! * cy + m[5]!) / w - cy,
          ),
        );
      }
      return peor;
    };

    expect(desplaza(1.5)).toBeGreaterThan(desplaza(0.3) * 1.05);
  });

  it('aun corrigiendo de menos, achica el temblor en vez de agrandarlo', () => {
    const muestras = fuerte();
    const e = prepararEstabilizacion(muestras, cuadros, { ...base, zoomMaximo: 1.1 });
    const reales = integrar(muestras, DIRECTO);

    // La misma medida que el test de direccion: cuanto se mueve el mundo visto
    // por el pixel del centro.
    const mirada = (m: number[], t: number) => {
      const cx = base.ancho / 2;
      const cy = base.alto / 2;
      const w = m[6]! * cx + m[7]! * cy + m[8]!;
      const px = (m[0]! * cx + m[1]! * cy + m[2]!) / w;
      const py = (m[3]! * cx + m[4]! * cy + m[5]!) / w;
      const v = [(px - cx) / base.focalPx, (py - cy) / base.focalPx, 1];
      const r = aMatriz(orientacionEn(reales, t));
      const d = [
        r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!,
        r[3]! * v[0]! + r[4]! * v[1]! + r[5]! * v[2]!,
        r[6]! * v[0]! + r[7]! * v[1]! + r[8]! * v[2]!,
      ];
      const n = Math.hypot(d[0]!, d[1]!, d[2]!);
      return [d[0]! / n, d[1]! / n, d[2]! / n] as const;
    };
    const abanico = (ds: (readonly [number, number, number])[]) => {
      let peor = 0;
      for (const a of ds) {
        for (const b of ds) {
          const c = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
          peor = Math.max(peor, (Math.acos(c) * 180) / Math.PI);
        }
      }
      return peor;
    };

    const identidad = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const antes = abanico(cuadros.map((t) => mirada(identidad, t)));
    const despues = abanico(cuadros.map((t) => mirada(e.matrizEn(t), t)));
    expect(despues).toBeLessThan(antes);
  });
});
