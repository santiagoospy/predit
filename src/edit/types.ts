import type { Lut3D } from '../color/cube';
import type { FitMode } from '../color/renderer';
import type { ClipInfo } from '../media/probe';

/**
 * Un LUT cargado una vez y reutilizable entre clips. Con tres camaras (FX6,
 * GoPro, DJI) cada una con su propio perfil, subir el mismo .cube por cada
 * clip seria tedioso: se carga una vez y despues se elige de la lista.
 */
export interface LibraryLut {
  id: string;
  name: string;
  lut: Lut3D;
}

/** Un clip en la linea de tiempo, con su propio recorte, velocidad y color. */
export interface TimelineClip {
  id: string;
  file: File;
  url: string;
  info: ClipInfo;
  warnings: string[];
  lutConvId: string | null;
  lutLookId: string | null;
  fit: FitMode;
  panX: number;
  panY: number;
  speed: number;
  trimIn: number;
  trimOut: number;
  /** Volumen del sonido propio del clip, de 0 a 1. */
  volume: number;
}

/**
 * La musica del proyecto: una sola pista que corre sobre toda la linea de
 * tiempo. Da lo mismo si salio de un .mp3 importado o del audio de un video,
 * porque en los dos casos termina siendo el mismo AudioBuffer decodificado.
 */
export interface MusicTrack {
  id: string;
  /** Para mostrar: el nombre del archivo, o el del clip del que se extrajo. */
  name: string;
  origen: 'archivo' | 'clip';
  /** Ya decodificada: se usa igual para escucharla y para mezclar el export. */
  buffer: AudioBuffer;
  duracionSeconds: number;
  /** Desde que segundo del tema arranca la musica en la linea de tiempo. */
  startInMusic: number;
  /** En que segundo del tema corta. Es la marca de salida, igual que en el video. */
  endInMusic: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

/** Duracion que ocupa el clip en la salida, ya con su velocidad aplicada. */
export function clipOutputDuration(clip: TimelineClip): number {
  return Math.max(0, (clip.trimOut - clip.trimIn) / clip.speed);
}

let counter = 0;

/**
 * IDs locales, sin crypto.randomUUID: esa API exige un contexto seguro
 * (https o localhost), y probar desde el celular por la red local es http
 * plano sobre una IP, que no califica.
 */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
