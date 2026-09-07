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
 * pixeles". Sin esto habria que pedirle al usuario que lo ajuste a ojo.
 */
export interface Optica {
  /**
   * Distancia focal en pixeles de la imagen de salida.
   *
   * Sale de la focal en nanometros dividida por el tamano del pixel, y despues
   * escalada del recorte del sensor al ancho del video.
   */
  focalPx: number;
  /** La focal en milimetros, solo para mostrarla y poder reconocerla. */
  focalMm: number;
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
