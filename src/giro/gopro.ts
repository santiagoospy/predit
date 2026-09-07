/**
 * El giroscopio de las GoPro (HERO 5 en adelante).
 *
 * GoPro escribe una pista GPMF, que es un formato anidado y autodescriptivo:
 * cada nodo son cuatro letras de nombre, una de tipo, el tamano de cada
 * elemento, cuantos hay, y el contenido, siempre alineado a cuatro bytes.
 *
 * A diferencia de Sony, aca no hay tags magicos que haya que conocer de
 * antemano: el archivo dice que es cada cosa. Lo unico que hay que saber es que
 * el giroscopio se llama GYRO y que su escala viene en un SCAL al lado, dentro
 * del mismo STRM.
 *
 * El formato esta documentado por GoPro (gopro/gpmf-parser).
 */

import type { ModeloRadial, MuestraGiro, Optica } from './tipos';

/** Un nodo del arbol GPMF. */
interface Nodo {
  clave: string;
  tipo: string;
  /** Donde arranca el contenido, y cuanto mide en total. */
  inicio: number;
  largo: number;
  /** Cuantos bytes ocupa cada elemento. */
  porElemento: number;
  cuantos: number;
}

/** Un nodo con tipo 0 no trae datos: trae mas nodos adentro. */
const ANIDADO = '\0';

function leerNodo(vista: DataView, pos: number, hasta: number): Nodo | null {
  if (pos + 8 > hasta) return null;
  const clave = String.fromCharCode(
    vista.getUint8(pos),
    vista.getUint8(pos + 1),
    vista.getUint8(pos + 2),
    vista.getUint8(pos + 3),
  );
  const tipo = String.fromCharCode(vista.getUint8(pos + 4));
  const porElemento = vista.getUint8(pos + 5);
  const cuantos = vista.getUint16(pos + 6);
  const largo = porElemento * cuantos;
  if (pos + 8 + largo > hasta) return null;
  return { clave, tipo, inicio: pos + 8, largo, porElemento, cuantos };
}

/** El siguiente nodo, saltando el relleno hasta el proximo multiplo de cuatro. */
function despues(nodo: Nodo): number {
  return nodo.inicio + Math.ceil(nodo.largo / 4) * 4;
}

function hijos(vista: DataView, nodo: Nodo): Nodo[] {
  const lista: Nodo[] = [];
  let pos = nodo.inicio;
  const hasta = nodo.inicio + nodo.largo;
  while (pos < hasta) {
    const hijo = leerNodo(vista, pos, hasta);
    if (!hijo) break;
    lista.push(hijo);
    pos = despues(hijo);
  }
  return lista;
}

/**
 * Lee un nodo numerico como lista de numeros.
 *
 * Solo estan los tipos que aparecen en las pistas de giroscopio: enteros con y
 * sin signo, y flotantes. El resto no hace falta y devolverlo mal seria peor
 * que no devolverlo.
 */
function numeros(vista: DataView, nodo: Nodo): number[] {
  const valores: number[] = [];
  const tamano =
    nodo.tipo === 'b' || nodo.tipo === 'B'
      ? 1
      : nodo.tipo === 's' || nodo.tipo === 'S'
        ? 2
        : nodo.tipo === 'l' || nodo.tipo === 'L' || nodo.tipo === 'f'
          ? 4
          : 0;
  if (tamano === 0) return valores;

  for (let pos = nodo.inicio; pos + tamano <= nodo.inicio + nodo.largo; pos += tamano) {
    switch (nodo.tipo) {
      case 'b':
        valores.push(vista.getInt8(pos));
        break;
      case 'B':
        valores.push(vista.getUint8(pos));
        break;
      case 's':
        valores.push(vista.getInt16(pos));
        break;
      case 'S':
        valores.push(vista.getUint16(pos));
        break;
      case 'l':
        valores.push(vista.getInt32(pos));
        break;
      case 'L':
        valores.push(vista.getUint32(pos));
        break;
      case 'f':
        valores.push(vista.getFloat32(pos));
        break;
    }
  }
  return valores;
}

/** Lee un nodo de tipo caracter como texto. */
function texto(vista: DataView, nodo: Nodo): string {
  let salida = '';
  for (let i = 0; i < nodo.largo; i++) {
    const c = vista.getUint8(nodo.inicio + i);
    if (c === 0) break;
    salida += String.fromCharCode(c);
  }
  return salida.trim();
}

/** Como llama GoPro a cada modo de lente. */
const MODOS: Record<string, string> = {
  W: 'Wide',
  L: 'Linear',
  N: 'Narrow',
  M: 'Medium',
  S: 'Superview',
  H: 'Hyperview',
  X: 'Max Superview',
};

/**
 * La calibracion del lente, que GoPro escribe junto al resto de la telemetria.
 *
 * Vive en el flujo global del dispositivo y no adentro de un stream de datos,
 * asi que se busca por todo el arbol en vez de mirar solo los STRM.
 */
function mapaDeClaves(vista: DataView, raiz: Nodo[]): Map<string, Nodo> {
  const hallado = new Map<string, Nodo>();
  const recorrer = (nodos: Nodo[]) => {
    for (const nodo of nodos) {
      if (nodo.tipo === ANIDADO) recorrer(hijos(vista, nodo));
      else if (!hallado.has(nodo.clave)) hallado.set(nodo.clave, nodo);
    }
  };
  recorrer(raiz);
  return hallado;
}

function buscarLente(
  vista: DataView,
  hallado: Map<string, Nodo>,
  anchoDelVideo: number,
): Optica | null {
  const lista = (clave: string): number[] => {
    const nodo = hallado.get(clave);
    return nodo ? numeros(vista, nodo) : [];
  };

  const poly = lista('POLY');
  const zmpl = lista('ZMPL')[0];
  const vres = lista('VRES');
  // El primer coeficiente que importa es el lineal: es el que fija la escala.
  const r1 = poly[1];
  if (poly.length < 2 || !zmpl || !r1 || vres.length < 2) return null;
  const [w, h] = [vres[0]!, vres[1]!];
  if (!(w > 0) || !(h > 0)) return null;

  // Superview y Hyperview estiran la imagen a lo ancho despues de capturarla, y
  // ese estiramiento cambia la escala efectiva del lente.
  const arwa = lista('ARWA')[0];
  const aruw = lista('ARUW')[0];
  const factor = arwa && aruw && arwa > 0 && aruw > 0 ? arwa / aruw : 1;

  const mediaDiagonal = 0.5 * Math.hypot(w, h);
  const focalCalibrada = mediaDiagonal / (r1 * zmpl * factor);
  if (!Number.isFinite(focalCalibrada) || focalCalibrada <= 0) return null;

  // La calibracion puede venir a otra resolucion que el video: la focal escala
  // linealmente con el ancho.
  const focalPx = anchoDelVideo > 0 ? focalCalibrada * (anchoDelVideo / w) : null;

  const zfov = lista('ZFOV')[0];
  const modoCrudo = hallado.has('VFOV') ? texto(vista, hallado.get('VFOV')!) : '';

  const radial: ModeloRadial = {
    poly,
    zmpl,
    // El campo diagonal viene en grados; la mitad es el rayo mas abierto.
    anguloMaxRad: zfov && zfov > 0 && zfov < 178 ? ((zfov * 0.5 * Math.PI) / 180) : null,
    modo: MODOS[modoCrudo] ?? modoCrudo,
  };

  return { focalPx, focalMm: null, sensorAnchoMm: null, anchoPx: anchoDelVideo, radial };
}

/**
 * Junta las ternas de giroscopio de una muestra, ya escaladas.
 *
 * Recorre los DEVC y sus STRM buscando el que tenga un GYRO. El SCAL vive en el
 * mismo STRM y puede traer un divisor por eje o uno solo para los tres.
 */
function ternasDeMuestra(vista: DataView, raiz: Nodo[]): { x: number; y: number; z: number }[] {
  const ternas: { x: number; y: number; z: number }[] = [];

  const verStream = (stream: Nodo) => {
    const partes = hijos(vista, stream);
    const gyro = partes.find((p) => p.clave === 'GYRO');
    if (!gyro) return;
    const scal = partes.find((p) => p.clave === 'SCAL');
    const divisores = scal ? numeros(vista, scal) : [];
    const crudos = numeros(vista, gyro);
    // El GYRO viene como ternas pegadas: x, y, z, x, y, z...
    for (let i = 0; i + 2 < crudos.length; i += 3) {
      const d = (eje: number) => {
        const div = divisores.length === 1 ? divisores[0]! : (divisores[eje] ?? 1);
        return div === 0 ? 1 : div;
      };
      ternas.push({
        x: crudos[i]! / d(0),
        y: crudos[i + 1]! / d(1),
        z: crudos[i + 2]! / d(2),
      });
    }
  };

  for (const nodo of raiz) {
    if (nodo.tipo !== ANIDADO) continue;
    if (nodo.clave === 'DEVC') {
      for (const hijo of hijos(vista, nodo)) {
        if (hijo.clave === 'STRM' && hijo.tipo === ANIDADO) verStream(hijo);
      }
    } else if (nodo.clave === 'STRM') {
      verStream(nodo);
    }
  }
  return ternas;
}

/**
 * Convierte las muestras crudas de la pista en mediciones con segundos y
 * grados por segundo.
 *
 * GoPro no dice a que frecuencia corre el giroscopio, pero cada muestra de la
 * pista cubre un tramo conocido del clip (lo dice la tabla del MP4), asi que
 * las mediciones de adentro se reparten parejo en ese tramo. Es lo mismo que
 * hacen las otras herramientas y da un error despreciable.
 */
export function leerGoPro(
  muestras: { bytes: ArrayBuffer; segundo: number }[],
  anchoDelVideo = 0,
): { muestras: MuestraGiro[]; optica: Optica | null; claves: string[] } {
  const salida: MuestraGiro[] = [];
  let lente: Optica | null = null;
  /**
   * Todas las claves GPMF que aparecieron.
   *
   * Es diagnostico y no adorno: si la calibracion del lente no aparece, esto
   * dice si el archivo la trae bajo otro nombre o directamente no la trae
   * -que pasa con los modelos y firmwares que no la escriben-. Sin esto, "no
   * la encontre" no distingue un error mio de una camara que no la guarda.
   */
  const claves = new Set<string>();

  for (let i = 0; i < muestras.length; i++) {
    const muestra = muestras[i]!;
    const vista = new DataView(muestra.bytes);
    const raiz: Nodo[] = [];
    let pos = 0;
    while (pos < vista.byteLength) {
      const nodo = leerNodo(vista, pos, vista.byteLength);
      if (!nodo) break;
      raiz.push(nodo);
      pos = despues(nodo);
    }

    // La calibracion no cambia dentro de un clip: se busca hasta encontrarla.
    if (!lente) {
      const hallado = mapaDeClaves(vista, raiz);
      for (const clave of hallado.keys()) claves.add(clave);
      lente = buscarLente(vista, hallado, anchoDelVideo);
    }

    const ternas = ternasDeMuestra(vista, raiz);
    if (ternas.length === 0) continue;

    // Cuanto dura esta muestra: hasta la siguiente, o lo mismo que la anterior
    // si es la ultima.
    const siguiente = muestras[i + 1];
    const anterior = muestras[i - 1];
    const duracion = siguiente
      ? siguiente.segundo - muestra.segundo
      : anterior
        ? muestra.segundo - anterior.segundo
        : 0;
    const paso = ternas.length > 0 ? duracion / ternas.length : 0;

    for (let j = 0; j < ternas.length; j++) {
      const terna = ternas[j]!;
      salida.push({
        segundo: muestra.segundo + j * paso,
        x: terna.x,
        y: terna.y,
        z: terna.z,
      });
    }
  }

  return { muestras: salida, optica: lente, claves: [...claves].sort() };
}
