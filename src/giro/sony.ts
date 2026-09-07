/**
 * El giroscopio de las camaras Sony (FX30, FX3, ZV-E10 II, A7S III, y la lista
 * sigue).
 *
 * Sony escribe una pista RTMD ("real time metadata") con una muestra por
 * cuadro. Adentro de cada muestra hay una lista plana de tags: dos bytes de
 * numero de tag, dos de largo, y el contenido. Cada cuadro trae un puñado de
 * mediciones del giroscopio -unas 8 a 16, porque el giroscopio corre mucho mas
 * rapido que el video- y ademas la escala y la frecuencia para poder
 * interpretarlas.
 *
 * Los numeros de tag y la forma de leerlos salen de telemetry-parser, que es la
 * libreria que usa Gyroflow (src/sony/rtmd_tags.rs). No hay documentacion
 * publica de Sony: esto es ingenieria inversa ajena, bien hecha y verificada
 * contra camaras de verdad.
 */

import { focalPxDesdeMm, type MuestraGiro, type Optica } from './tipos';

/** Los tags que interesan. El resto de la muestra se saltea. */
const TAG_FRECUENCIA = 0xe435;
const TAG_ESCALA_UNIDAD = 0xe438;
const TAG_ESCALA = 0xe439;
const TAG_ORIENTACION = 0xe43a;
const TAG_DATOS = 0xe43b;
/**
 * Los tags de la optica, con los que se calcula la focal en pixeles.
 *
 * La focal viene en nanometros (el eje z de la posicion del lente) y el tamano
 * del pixel tambien, asi que dividiendo una por el otro sale la focal medida en
 * pixeles del sensor. Como el video no usa el sensor entero, despues hay que
 * escalarla del recorte al ancho de la imagen.
 */
const TAG_PIXEL_UNIDAD = 0xe406;
const TAG_PIXEL_TAMANO = 0xe407;
const TAG_RECORTE_UNIDAD = 0xe408;
const TAG_RECORTE_TAMANO = 0xe40a;
const TAG_LENTE_POSICION = 0xe410;

/** Un tag que contiene otros tags adentro. */
const TAG_CONTENEDOR = 0x8300;
/**
 * El prefijo de una clave larga (SMPTE UL). No es un tag: marca el arranque de
 * un bloque y hay que saltear sus 16 bytes para seguir leyendo.
 */
const MARCA_UL = 0x060e;

/**
 * Donde empieza el contenido util de la muestra.
 *
 * Los primeros 0x1C bytes son la cabecera de la pista, y los dos primeros valen
 * exactamente 0x001C: es la forma de reconocer que esta muestra es RTMD de
 * verdad y no otra cosa.
 */
const CABECERA = 0x1c;

interface Crudo {
  /** Las ternas en unidades del sensor, sin escalar. */
  ternas: { x: number; y: number; z: number }[];
  escala: number | null;
  /** false = la escala esta en grados por segundo; true = radianes. */
  enRadianes: boolean;
  frecuencia: number | null;
  orientacion: string | null;
  /** Focal en nanometros, del eje z de la posicion del lente. */
  focalNm: number | null;
  /** Ancho del pixel, en 1/pixelUnidad metros. */
  pixelAncho: number | null;
  pixelUnidad: number | null;
  /** Ancho del recorte del sensor, en 1/recorteUnidad pixeles. */
  recorteAncho: number | null;
  recorteUnidad: number | null;
}

function crudoVacio(): Crudo {
  return {
    ternas: [],
    escala: null,
    enRadianes: false,
    frecuencia: null,
    orientacion: null,
    focalNm: null,
    pixelAncho: null,
    pixelUnidad: null,
    recorteAncho: null,
    recorteUnidad: null,
  };
}

/**
 * Lo que se puede saber de la optica con lo que escribio la camara.
 *
 * El ancho del sensor sale siempre, porque el tamano del pixel y el recorte los
 * escribe la camara. La focal solo si el lente la declaro: con un lente manual
 * queda en null y el usuario la carga a mano.
 */
function optica(c: Crudo, anchoDelVideo: number): Optica | null {
  if (anchoDelVideo <= 0) return null;

  let sensorAnchoMm: number | null = null;
  if (c.pixelAncho && c.recorteAncho) {
    // El tamano del pixel viene en nanometros salvo que la camara diga otra
    // unidad; el recorte, en pixeles del sensor. Multiplicados dan el ancho
    // fisico que se esta leyendo.
    const pixelNm = (c.pixelAncho * 1e9) / (c.pixelUnidad ?? 1e9);
    const recortePx = c.recorteAncho / (c.recorteUnidad ?? 1);
    if (pixelNm > 0 && recortePx > 0) sensorAnchoMm = (pixelNm * recortePx) / 1e6;
  }

  const focalMm = c.focalNm ? c.focalNm / 1e6 : null;
  const focalPx =
    focalMm !== null && sensorAnchoMm !== null
      ? focalPxDesdeMm(focalMm, sensorAnchoMm, anchoDelVideo)
      : null;

  if (sensorAnchoMm === null && focalMm === null) return null;
  return { focalPx, focalMm, sensorAnchoMm, anchoPx: anchoDelVideo };
}

function esRtmd(vista: DataView): boolean {
  return vista.byteLength > CABECERA && vista.getUint16(0) === CABECERA;
}

/**
 * Recorre los tags de un bloque y va llenando lo que encuentra.
 *
 * Se llama a si misma para los contenedores, que es como Sony agrupa el bloque
 * del giroscopio adentro de la muestra.
 */
function recorrer(vista: DataView, desde: number, hasta: number, salida: Crudo): void {
  let pos = desde;
  while (pos + 4 <= hasta) {
    const tag = vista.getUint16(pos);
    if (tag === MARCA_UL) {
      // Clave larga: dos bytes ya leidos mas catorce que faltan.
      pos += 16;
      continue;
    }
    // El relleno del final de la muestra son ceros, y 0xffff cierra.
    if (tag === 0 || tag === 0xffff) return;

    const largo = vista.getUint16(pos + 2);
    const inicio = pos + 4;
    if (inicio + largo > hasta) return;

    if (tag === TAG_CONTENEDOR) {
      recorrer(vista, inicio, inicio + largo, salida);
    } else if (tag === TAG_FRECUENCIA && largo >= 4) {
      salida.frecuencia = vista.getInt32(inicio);
    } else if (tag === TAG_ESCALA && largo >= 4) {
      salida.escala = vista.getFloat32(inicio);
    } else if (tag === TAG_ESCALA_UNIDAD && largo >= 1) {
      salida.enRadianes = vista.getUint8(inicio) !== 0;
    } else if (tag === TAG_ORIENTACION && largo >= 3) {
      salida.orientacion = String.fromCharCode(
        vista.getUint8(inicio),
        vista.getUint8(inicio + 1),
        vista.getUint8(inicio + 2),
      );
    } else if (tag === TAG_LENTE_POSICION && largo >= 12) {
      // x, y, z en nanometros; la focal es la z.
      salida.focalNm = vista.getInt32(inicio + 8);
    } else if (tag === TAG_PIXEL_TAMANO && largo >= 4) {
      salida.pixelAncho = vista.getInt16(inicio);
    } else if (tag === TAG_PIXEL_UNIDAD && largo >= 4) {
      salida.pixelUnidad = vista.getInt32(inicio);
    } else if (tag === TAG_RECORTE_TAMANO && largo >= 8) {
      salida.recorteAncho = vista.getUint32(inicio);
    } else if (tag === TAG_RECORTE_UNIDAD && largo >= 4) {
      salida.recorteUnidad = vista.getInt32(inicio);
    } else if (tag === TAG_DATOS && largo >= 8) {
      // Cantidad, largo de cada terna (siempre 6 = tres enteros de 16 bits), y
      // despues las ternas uno atras del otro.
      const cuantas = vista.getInt32(inicio);
      const porTerna = vista.getInt32(inicio + 4);
      if (porTerna === 6 && cuantas > 0) {
        for (let i = 0; i < cuantas; i++) {
          const p = inicio + 8 + i * 6;
          if (p + 6 > inicio + largo) break;
          salida.ternas.push({
            x: vista.getInt16(p),
            y: vista.getInt16(p + 2),
            z: vista.getInt16(p + 4),
          });
        }
      }
    }

    pos = inicio + largo;
  }
}

/**
 * Convierte las muestras crudas de la pista en mediciones con segundos y
 * grados por segundo.
 *
 * Cada muestra del archivo cubre un cuadro y trae varias mediciones adentro.
 * Los tiempos se reparten dentro del cuadro usando la frecuencia del
 * giroscopio: la camara no guarda un timestamp por medicion, pero si dice a
 * cuantos hertz corre, y con eso alcanza.
 */
export function leerSony(
  muestras: { bytes: ArrayBuffer; segundo: number }[],
  anchoDelVideo = 0,
): { muestras: MuestraGiro[]; optica: Optica | null } {
  const salida: MuestraGiro[] = [];
  let lente: Optica | null = null;
  let escala: number | null = null;
  let enRadianes = false;
  let frecuencia: number | null = null;

  for (const muestra of muestras) {
    const vista = new DataView(muestra.bytes);
    if (!esRtmd(vista)) continue;

    const crudo = crudoVacio();
    recorrer(vista, CABECERA, vista.byteLength, crudo);
    // La optica se lee una sola vez: no cambia dentro de un clip.
    if (!lente && anchoDelVideo > 0) lente = optica(crudo, anchoDelVideo);
    if (crudo.ternas.length === 0) continue;

    // La escala y la frecuencia suelen venir solo en algunas muestras: la
    // ultima que se vio vale para las que siguen.
    if (crudo.escala !== null && crudo.escala !== 0) escala = crudo.escala;
    if (crudo.frecuencia !== null && crudo.frecuencia > 0) frecuencia = crudo.frecuencia;
    enRadianes = crudo.enRadianes;

    // El paso entre mediciones dentro del cuadro. Sin frecuencia declarada no
    // hay nada mejor que amontonarlas todas en el momento del cuadro.
    const paso = frecuencia ? 1 / frecuencia : 0;

    for (let i = 0; i < crudo.ternas.length; i++) {
      const terna = crudo.ternas[i]!;
      // La escala es "cuantas unidades del sensor entran en un grado por
      // segundo", asi que se divide.
      const k = escala && escala !== 0 ? 1 / escala : 1;
      const aGrados = enRadianes ? 180 / Math.PI : 1;
      salida.push({
        segundo: muestra.segundo + i * paso,
        // Sony ordena las ternas como pitch, roll, yaw.
        x: terna.x * k * aGrados,
        y: terna.y * k * aGrados,
        z: terna.z * k * aGrados,
      });
    }
  }

  return { muestras: salida, optica: lente };
}
