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
