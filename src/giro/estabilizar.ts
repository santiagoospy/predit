/**
 * De las mediciones del giroscopio a la correccion que va al shader.
 *
 * El camino es siempre el mismo, y son cuatro pasos:
 *
 *  1. INTEGRAR. El giroscopio no dice hacia donde apunta la camara, dice a que
 *     velocidad esta girando. Sumando esas velocidades cuadro a cuadro se
 *     reconstruye la orientacion real en cada momento.
 *  2. SUAVIZAR. Esa orientacion real incluye el temblor de la mano. Pasandola
 *     por un filtro se obtiene una camara "virtual" que hace el mismo
 *     movimiento pero sin los saltos.
 *  3. CORREGIR. La diferencia entre las dos es cuanto hay que rotar la imagen
 *     para que se vea como si la camara hubiera hecho el movimiento suave.
 *  4. RECORTAR. Rotar la imagen descubre los bordes, asi que hay que agrandarla
 *     lo justo para que no entre negro en ningun cuadro.
 *
 * Lo que NO hace, por decision explicita: no corrige la distorsion del lente
 * (no hay perfil de lente) ni el obturador rodante. Las dos cosas mejoran el
 * resultado, pero las dos necesitan datos que hoy no tenemos, y sin ellas la
 * estabilizacion ya funciona.
 */

import {
  aMatriz,
  desdeVelocidad,
  IDENTIDAD,
  inverso,
  multiplicar,
  normalizar,
  slerp,
  type Quat,
} from './quat';
import type { MuestraGiro } from './tipos';

/** La orientacion de la camara en un momento del clip. */
export interface Orientacion {
  segundo: number;
  q: Quat;
}

/**
 * Como se mapean los ejes del giroscopio a los de la imagen.
 *
 * Es lo unico que no se puede deducir de los datos: cada fabricante monta el
 * chip como quiere, y si los ejes estan cruzados la correccion va para el lado
 * equivocado y la imagen tiembla el doble en vez de la mitad. Se deja
 * configurable justamente porque la unica forma de confirmarlo es probar con un
 * clip de verdad.
 *
 * Cada entrada dice de que eje del giroscopio sale, y con que signo.
 */
export interface Mapeo {
  pitch: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
  yaw: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
  roll: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
}

/**
 * Traduce la orientacion que declara la camara a un mapeo de ejes.
 *
 * Tanto GoPro (la clave ORIN) como Sony (el tag 0xe43a) escriben una cadena de
 * tres letras que dice, para cada canal guardado, a que eje de la camara
 * corresponde. La mayuscula es el eje positivo y la minuscula el negativo: por
 * ejemplo "ZXY" quiere decir que el primer canal es el eje Z, el segundo el X y
 * el tercero el Y; "Zxy" seria lo mismo con los dos ultimos invertidos.
 *
 * Esto es exactamente lo que antes habia que adivinar. Con la cadena del propio
 * archivo, el mapeo deja de ser una suposicion que solo se confirma probando.
 */
export function mapeoDesdeOrientacion(declarada: string): Mapeo | null {
  const limpia = declarada.trim();
  if (limpia.length !== 3) return null;

  const canales = ['x', 'y', 'z'] as const;
  const destino = new Map<string, { de: 'x' | 'y' | 'z'; signo: 1 | -1 }>();

  for (let i = 0; i < 3; i++) {
    const letra = limpia[i]!;
    const eje = letra.toLowerCase();
    if (eje !== 'x' && eje !== 'y' && eje !== 'z') return null;
    // La minuscula marca el eje invertido.
    destino.set(eje, { de: canales[i]!, signo: letra === eje ? -1 : 1 });
  }

  const pitch = destino.get('x');
  const yaw = destino.get('y');
  const roll = destino.get('z');
  // Si algun eje se repite, falta otro y el mapeo no sirve.
  if (!pitch || !yaw || !roll) return null;
  return { pitch, yaw, roll };
}

/**
 * El mapeo de Sony.
 *
 * Sony ordena las ternas como pitch, roll, yaw (asi esta anotado en
 * telemetry-parser), y ademas su convencion tiene los ejes X e Y cambiados y el
 * Z invertido respecto de la imagen.
 */
export const MAPEO_SONY: Mapeo = {
  pitch: { de: 'y', signo: 1 },
  yaw: { de: 'x', signo: 1 },
  roll: { de: 'z', signo: -1 },
};

/** El mapeo de GoPro, que escribe los ejes en otro orden. */
export const MAPEO_GOPRO: Mapeo = {
  pitch: { de: 'y', signo: -1 },
  yaw: { de: 'z', signo: -1 },
  roll: { de: 'x', signo: 1 },
};

const GRADOS_A_RADIANES = Math.PI / 180;

/**
 * Reconstruye la orientacion de la camara sumando las velocidades.
 *
 * El paso de tiempo sale de la diferencia entre mediciones y no de la
 * frecuencia declarada: si la pista tiene un hueco -y las tienen- usar el paso
 * nominal correria todo lo que viene despues.
 */
export function integrar(muestras: MuestraGiro[], mapeo: Mapeo): Orientacion[] {
  const salida: Orientacion[] = [];
  if (muestras.length === 0) return salida;

  const eje = (m: MuestraGiro, cual: Mapeo['pitch']) => m[cual.de] * cual.signo * GRADOS_A_RADIANES;

  let q: Quat = IDENTIDAD;
  salida.push({ segundo: muestras[0]!.segundo, q });

  for (let i = 1; i < muestras.length; i++) {
    const m = muestras[i]!;
    const dt = m.segundo - muestras[i - 1]!.segundo;
    // Un salto grande es un corte en la pista, no un giro de dos segundos:
    // integrarlo inventaria una rotacion enorme.
    if (dt > 0 && dt < 0.5) {
      q = normalizar(multiplicar(q, desdeVelocidad([eje(m, mapeo.pitch), eje(m, mapeo.yaw), eje(m, mapeo.roll)], dt)));
    }
    salida.push({ segundo: m.segundo, q });
  }
  return salida;
}

/**
 * El filtro que saca el temblor y deja el movimiento.
 *
 * Es un pasabajos exponencial aplicado en las dos direcciones: primero hacia
 * adelante y despues hacia atras. Pasarlo dos veces no es por prolijidad, es
 * necesario: un filtro en una sola direccion siempre atrasa la senal, y una
 * correccion atrasada es peor que ninguna porque mueve la imagen justo despues
 * del golpe. Yendo y volviendo, los dos atrasos se cancelan.
 *
 * `suavidad` es cuantos segundos de movimiento se promedian: mas alto es una
 * camara mas quieta, pero tambien mas recorte y mas sensacion de flotar.
 */
export function suavizar(orientaciones: Orientacion[], suavidad: number): Orientacion[] {
  if (orientaciones.length === 0) return [];
  if (suavidad <= 0) return orientaciones.map((o) => ({ ...o }));

  const paso = (lista: Orientacion[], atras: boolean): Orientacion[] => {
    const salida = lista.map((o) => ({ segundo: o.segundo, q: o.q }));
    const indices = atras
      ? [...salida.keys()].reverse()
      : [...salida.keys()];

    let acumulado = salida[indices[0]!]!.q;
    for (const i of indices) {
      const actual = salida[i]!;
      const previo = atras ? salida[i + 1] : salida[i - 1];
      const dt = previo ? Math.abs(actual.segundo - previo.segundo) : 0;
      // Cuanto pesa la medicion nueva: con dt chico frente a la suavidad, casi
      // nada, y la orientacion filtrada se mueve despacio.
      const alfa = dt > 0 ? 1 - Math.exp(-dt / suavidad) : 1;
      acumulado = normalizar(slerp(acumulado, actual.q, alfa));
      salida[i] = { segundo: actual.segundo, q: acumulado };
    }
    return salida;
  };

  return paso(paso(orientaciones, false), true);
}

/** Busca la orientacion en un momento cualquiera, interpolando entre mediciones. */
export function orientacionEn(lista: Orientacion[], segundo: number): Quat {
  if (lista.length === 0) return IDENTIDAD;
  if (segundo <= lista[0]!.segundo) return lista[0]!.q;
  const ultimo = lista[lista.length - 1]!;
  if (segundo >= ultimo.segundo) return ultimo.q;

  // Busqueda binaria: la lista puede tener decenas de miles de entradas y esto
  // se llama una vez por cuadro.
  let bajo = 0;
  let alto = lista.length - 1;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (lista[medio]!.segundo <= segundo) bajo = medio;
    else alto = medio;
  }
  const a = lista[bajo]!;
  const b = lista[alto]!;
  const span = b.segundo - a.segundo;
  return span > 0 ? slerp(a.q, b.q, (segundo - a.segundo) / span) : a.q;
}

export interface Opciones {
  /** Cuantos segundos de movimiento se promedian. */
  suavidad: number;
  /**
   * Cuanto se corre el giroscopio respecto del video, en segundos.
   *
   * Positivo significa que el giroscopio va adelantado y hay que atrasarlo. En
   * Sony y GoPro los relojes son buenos y esto queda casi siempre en cero; esta
   * para poder ajustarlo a ojo cuando no.
   */
  desfase: number;
  /**
   * La distancia focal en pixeles de la imagen de salida.
   *
   * Es lo que traduce "la camara giro un grado" a "la imagen se corre tantos
   * pixeles". Sin perfil de lente se saca de la metadata de la camara, y si no
   * esta, el usuario la ajusta a ojo.
   */
  focalPx: number;
  ancho: number;
  alto: number;
  mapeo: Mapeo;
}

/** La estabilizacion ya resuelta, lista para que la consulte el renderer. */
export interface Estabilizacion {
  /**
   * La matriz 3x3 que lleva un pixel de la imagen de SALIDA al pixel de la
   * imagen de ENTRADA que hay que muestrear, en orden por filas.
   */
  matrizEn: (segundo: number) => number[];
  /** Cuanto hay que agrandar la imagen para que no entren bordes negros. */
  zoom: number;
  /** El angulo maximo que llega a corregir, en grados. Es el diagnostico. */
  correccionMaxGrados: number;
}

/**
 * Arma la matriz de muestreo para una correccion dada.
 *
 * Es K · R⁻¹ · K⁻¹ con K la matriz de la camara: se lleva el pixel de salida al
 * rayo que le corresponde, se lo rota hacia donde estaba la camara de verdad, y
 * se lo vuelve a proyectar a pixel. El zoom entra achicando la focal del lado
 * de la salida, que es lo mismo que acercar la camara virtual.
 */
function matrizDeMuestreo(q: Quat, o: Opciones, zoom: number): number[] {
  const r = aMatriz(inverso(q));
  const cx = o.ancho / 2;
  const cy = o.alto / 2;
  const fEntrada = o.focalPx;
  const fSalida = o.focalPx * zoom;

  // K⁻¹ del lado de la salida, R, y K del lado de la entrada, multiplicadas a
  // mano: son matrices con muchos ceros y armar el producto general seria mas
  // codigo y mas lento.
  const m: number[] = [];
  for (let fila = 0; fila < 3; fila++) {
    for (let col = 0; col < 3; col++) {
      // Columna de K⁻¹ (salida): [1/f, 0, -cx/f; 0, 1/f, -cy/f; 0, 0, 1]
      const kx = col === 0 ? 1 / fSalida : col === 2 ? -cx / fSalida : 0;
      const ky = col === 1 ? 1 / fSalida : col === 2 ? -cy / fSalida : 0;
      const kz = col === 2 ? 1 : 0;
      // R por esa columna.
      const rx = r[0]! * kx + r[1]! * ky + r[2]! * kz;
      const ry = r[3]! * kx + r[4]! * ky + r[5]! * kz;
      const rz = r[6]! * kx + r[7]! * ky + r[8]! * kz;
      // K (entrada) por el resultado.
      m.push(fila === 0 ? fEntrada * rx + cx * rz : fila === 1 ? fEntrada * ry + cy * rz : rz);
    }
  }
  return m;
}

/** Aplica la matriz a un punto y hace la division de perspectiva. */
function aplicar(m: number[], x: number, y: number): [number, number] {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  const k = Math.abs(w) < 1e-9 ? 1e9 : 1 / w;
  return [(m[0]! * x + m[1]! * y + m[2]!) * k, (m[3]! * x + m[4]! * y + m[5]!) * k];
}

/**
 * El zoom mas chico que evita los bordes negros en TODO el clip.
 *
 * Se prueba por biseccion: con un zoom candidato se transforman las cuatro
 * esquinas de cada cuadro y se mira si alguna cae fuera de la imagen original.
 * Es fuerza bruta, pero corre una sola vez al preparar el clip y son unas pocas
 * decenas de miles de multiplicaciones.
 *
 * Se mira una muestra de cuadros y no todos: el zoom lo decide el peor momento
 * del clip, y ese momento dura mucho mas que un cuadro.
 */
function zoomNecesario(correcciones: Quat[], o: Opciones): number {
  const esquinas: [number, number][] = [
    [0, 0],
    [o.ancho, 0],
    [0, o.alto],
    [o.ancho, o.alto],
  ];

  const alcanza = (zoom: number): boolean => {
    for (const q of correcciones) {
      const m = matrizDeMuestreo(q, o, zoom);
      for (const [ex, ey] of esquinas) {
        const [px, py] = aplicar(m, ex, ey);
        if (px < 0 || py < 0 || px > o.ancho || py > o.alto) return false;
      }
    }
    return true;
  };

  if (alcanza(1)) return 1;
  let bajo = 1;
  let alto = 4;
  if (!alcanza(alto)) return alto;
  for (let i = 0; i < 24; i++) {
    const medio = (bajo + alto) / 2;
    if (alcanza(medio)) alto = medio;
    else bajo = medio;
  }
  return alto;
}

/**
 * Prepara la estabilizacion de un clip.
 *
 * `cuadros` son los momentos en los que se va a pedir la correccion, y sirven
 * para calcular el zoom: hay que conocer el peor cuadro del clip ANTES de
 * dibujar el primero, porque el zoom tiene que ser el mismo en todos (si
 * cambiara cuadro a cuadro, la imagen respiraria).
 */
export function prepararEstabilizacion(
  muestras: MuestraGiro[],
  cuadros: number[],
  o: Opciones,
): Estabilizacion {
  const reales = integrar(muestras, o.mapeo);
  const suaves = suavizar(reales, o.suavidad);

  const correccionEn = (segundo: number): Quat => {
    const t = segundo + o.desfase;
    // La suave por la inversa de la real: cuanto hay que rotar la imagen para
    // que la camara real se vea como la virtual.
    return normalizar(multiplicar(orientacionEn(suaves, t), inverso(orientacionEn(reales, t))));
  };

  const deLosCuadros = cuadros.map(correccionEn);
  const zoom = zoomNecesario(deLosCuadros, o);

  let maximo = 0;
  for (const q of deLosCuadros) {
    maximo = Math.max(maximo, 2 * Math.acos(Math.min(1, Math.abs(q[0]))));
  }

  return {
    matrizEn: (segundo) => matrizDeMuestreo(correccionEn(segundo), o, zoom),
    zoom,
    correccionMaxGrados: (maximo * 180) / Math.PI,
  };
}
