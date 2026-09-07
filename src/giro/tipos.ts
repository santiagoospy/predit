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
}

/** Por que no se pudo leer el giroscopio. Se muestra tal cual al usuario. */
export interface SinGiro {
  motivo: string;
  /** Las pistas de metadata que si aparecieron, para saber que se encontro. */
  pistas: string[];
}
