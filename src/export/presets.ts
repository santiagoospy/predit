export interface ExportPreset {
  id: string;
  nombre: string;
  detalle: string;
  width: number;
  height: number;
}

/**
 * Los tres destinos posibles. Edits acepta los tres, pero cada uno tiene
 * su costo: el vertical ya sale encuadrado, el UHD pesa varias veces mas.
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'v1080',
    nombre: 'Vertical 9:16',
    detalle: '1080×1920 · sale listo para reel, recortado desde el material',
    width: 1080,
    height: 1920,
  },
  {
    id: 'h1080',
    nombre: '1080p horizontal',
    detalle: '1920×1080 · liviano de pasar al celular, Edits reencuadra despues',
    width: 1920,
    height: 1080,
  },
  {
    id: 'uhd',
    nombre: 'UHD 4K',
    detalle: '3840×2160 · maxima calidad, archivos grandes',
    width: 3840,
    height: 2160,
  },
];

/** Vertical por defecto: el destino es Edits, y ahi todo es 9:16. */
export const DEFAULT_PRESET = EXPORT_PRESETS[0]!;

/** Cuadros por segundo del proyecto. 25 es lo coherente con grabar a 50p y conformar. */
export const DEFAULT_FRAME_RATE = 25;

/**
 * Velocidad que hace que cada cuadro del archivo ocupe exactamente un cuadro de
 * la salida. Es la camara lenta mas limpia posible: no inventa ni tira cuadros.
 *
 * Un clip de 50p en un proyecto de 25p da 0.5, o sea la mitad de velocidad.
 */
export function conformSpeed(sourceFrameRate: number, projectFrameRate: number): number {
  if (!Number.isFinite(sourceFrameRate) || sourceFrameRate <= 0) return 1;
  return projectFrameRate / sourceFrameRate;
}

/**
 * Hasta donde se puede ralentizar un clip sin repetir cuadros. Por debajo de
 * esto la imagen se ve entrecortada porque no hay cuadros reales que mostrar.
 */
export function minimumCleanSpeed(sourceFrameRate: number, projectFrameRate: number): number {
  return conformSpeed(sourceFrameRate, projectFrameRate);
}
