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

import type { MuestraGiro } from './tipos';

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
export function leerGoPro(muestras: { bytes: ArrayBuffer; segundo: number }[]): MuestraGiro[] {
  const salida: MuestraGiro[] = [];

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

  return salida;
}
