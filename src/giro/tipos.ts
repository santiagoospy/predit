/**
 * Lo que sale de leer el giroscopio, en unidades utiles y ya independiente de
 * que camara lo escribio.
 */

/** Una medicion del giroscopio: cuando, y cuanto giro en cada eje. */
export interface MuestraGiro {
  /** Segundos desde el arranque del clip. */
  segundo: number;
  /** Velocidad angular en grados por segundo. */
  x: number;
  y: number;
  z: number;
}

/** De donde salio el giroscopio. Determina como se leen los bytes. */
export type FuenteGiro = 'sony' | 'gopro';

/**
 * La optica con la que se filmo, leida de la metadata de la camara.
 *
 * Es lo que traduce "la camara giro un grado" a "la imagen se corre tantos
 * pixeles". La formula es simple: los grados que abarca la imagen dependen de
 * cuantos milimetros de sensor se estan leyendo y de la focal del lente.
 *
 * Las dos mitades vienen de lados distintos, y esto importa: el ancho del
 * sensor lo escribe la CAMARA (tamano del pixel por recorte del sensor), asi
 * que aparece siempre. La focal la escribe el LENTE, asi que con un lente
 * manual -sin contactos electricos- no aparece y la tiene que poner el usuario.
 */
export interface Optica {
  /**
   * Distancia focal en pixeles de la imagen de salida, o null si el lente no
   * declaro sus milimetros.
   */
  focalPx: number | null;
  /** Los milimetros que declaro el lente, o null si es manual. */
  focalMm: number | null;
  /**
   * Cuantos milimetros de ancho de sensor esta leyendo la camara.
   *
   * Es mejor que preguntar "aps-c o full frame": este numero ya tiene adentro
   * el modo de recorte (un cuerpo full frame filmando en Super35 lee 23 mm, no
   * 36) y el recorte del formato, que un menu de sensores no distinguiria.
   */
  sensorAnchoMm: number | null;
  /** El ancho de la imagen en pixeles, para recalcular con otra focal. */
  anchoPx: number;
}

/**
 * La focal en pixeles a partir de los milimetros del lente.
 *
 * Es una regla de tres: la focal es a los milimetros de sensor lo que la focal
 * en pixeles es al ancho de la imagen.
 */
export function focalPxDesdeMm(mm: number, sensorAnchoMm: number, anchoPx: number): number | null {
  if (!(mm > 0) || !(sensorAnchoMm > 0) || !(anchoPx > 0)) return null;
  return (mm / sensorAnchoMm) * anchoPx;
}

/** El giroscopio de un clip, listo para dibujar o para estabilizar. */
export interface DatosGiro {
  fuente: FuenteGiro;
  /** Las cuatro letras de la pista, para el diagnostico. */
  formato: string;
  muestras: MuestraGiro[];
  /** Cuantas mediciones por segundo tiene de verdad, medido y no declarado. */
  hz: number;
  /** Cuanto abarca, en segundos. */
  duracionSeconds: number;
  /** La optica, si la camara la escribio. GoPro no lo hace. */
  optica: Optica | null;
}

/** Por que no se pudo leer el giroscopio. Se muestra tal cual al usuario. */
export interface SinGiro {
  motivo: string;
  /** Las pistas de metadata que si aparecieron, para saber que se encontro. */
  pistas: string[];
}
