import type { Lut3D } from '../color/cube';
import type { FitMode, Framing } from '../color/renderer';
import type { ClipInfo } from '../media/probe';
import type { HuellaArchivo } from '../proyecto/esquema';

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
  /** Con que se reconoce el archivo al reabrir el proyecto. */
  huella: HuellaArchivo;
  /**
   * Si el tema salio de un clip, de cual. Al reabrir, re-vincular ese video
   * alcanza para rearmar la musica sola, sin pedir el mismo archivo dos veces.
   */
  clipId: string | null;
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

/**
 * Una capa que va ENCIMA del montaje: un logo, una placa, una marca de agua.
 *
 * A diferencia de un clip, no esta pegada a ninguno. Sus tiempos son absolutos
 * sobre la linea de tiempo, asi que la capa puede cruzar el corte entre dos
 * clips y quedarse quieta mientras la imagen de abajo cambia. Es la misma idea
 * que la musica, que tampoco pertenece a ningun clip.
 */
export interface OverlayLayer {
  id: string;
  name: string;
  /** Con que se reconoce la imagen al reabrir el proyecto. */
  huella: HuellaArchivo;
  /**
   * Ya decodificada. Una imagen estatica entra entera en memoria sin drama: un
   * cuadro 1920x1080 en RGBA son 8 MB. Una secuencia animada NO se podria
   * guardar asi, y por eso todavia no la hay.
   */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Segundos absolutos de la linea de tiempo, no de ningun archivo. */
  startSeconds: number;
  endSeconds: number;
  /** 1 = la capa entra justo entera en el lienzo. */
  scale: number;
  /**
   * Desplazamiento en NDC del lienzo: 0 es centrado, 1 es medio lienzo.
   *
   * Va en NDC y no en pixeles a proposito: asi el mismo numero vale igual en el
   * visor chico y en el export en UHD, sin convertir nada entre uno y otro.
   */
  offsetX: number;
  offsetY: number;
  /** La opacidad en reposo, o sea entre la entrada y la salida. */
  opacity: number;
  /**
   * Cuanto tarda la capa en aparecer y en irse, en segundos. En 0 aparece y
   * desaparece de golpe. En el medio la capa se queda quieta: es el mismo
   * modelo que el fadeIn/fadeOut de la musica.
   */
  entradaSeconds: number;
  salidaSeconds: number;
  /**
   * De que tamano sale la capa al aparecer y a cual va al irse, relativo a su
   * escala de reposo. 1 no mueve la escala; 0.8 entra creciendo; 1.2 entra
   * achicandose.
   */
  scaleEntrada: number;
  scaleSalida: number;
}

/**
 * Duracion que ocupa el clip en la salida, ya con su velocidad aplicada.
 *
 * Pide solo los tres numeros que usa, y no un `TimelineClip` entero, para que
 * tambien sirva sobre un clip guardado, que no tiene archivo ni info.
 */
export function clipOutputDuration(clip: {
  trimIn: number;
  trimOut: number;
  speed: number;
}): number {
  return Math.max(0, (clip.trimOut - clip.trimIn) / clip.speed);
}

/**
 * Si la capa se ve en ese segundo de la linea de tiempo.
 *
 * La entrada es inclusiva y la salida exclusiva, igual que el recorte de un
 * clip: asi dos tramos pegados no comparten un cuadro.
 */
export function capaVisibleEn(
  capa: { startSeconds: number; endSeconds: number },
  segundos: number,
): boolean {
  return segundos >= capa.startSeconds && segundos < capa.endSeconds;
}

/** El tamano y la transparencia de la capa en un instante dado. */
export interface CapaAnimada {
  scale: number;
  opacity: number;
}

/**
 * Como se ve la capa en un segundo dado de la linea de tiempo.
 *
 * La opacidad siempre funde desde cero en la entrada y hacia cero en la salida;
 * la escala solo se mueve si se le pidio. Entre la entrada y la salida la capa
 * se queda quieta en sus valores de reposo, que es lo que uno quiere de un
 * logo: entra, se queda, se va.
 */
export function capaEnSegundo(
  capa: {
    startSeconds: number;
    endSeconds: number;
    scale: number;
    opacity: number;
    entradaSeconds: number;
    salidaSeconds: number;
    scaleEntrada: number;
    scaleSalida: number;
  },
  segundos: number,
): CapaAnimada {
  const quieta = { scale: capa.scale, opacity: capa.opacity };
  const dura = Math.max(0, capa.endSeconds - capa.startSeconds);
  if (dura === 0) return quieta;

  let entrada = Math.max(0, capa.entradaSeconds);
  let salida = Math.max(0, capa.salidaSeconds);
  const total = entrada + salida;
  // Si la entrada y la salida no entran en el tramo se pisarian, y la capa
  // nunca llegaria a su valor de reposo. Se achican las dos en proporcion, asi
  // que al menos por un instante se ve entera.
  if (total > dura) {
    const factor = dura / total;
    entrada *= factor;
    salida *= factor;
  }

  const desdeElPrincipio = segundos - capa.startSeconds;
  if (entrada > 0 && desdeElPrincipio < entrada) {
    const t = suavizar(desdeElPrincipio / entrada);
    return { scale: capa.scale * mezclar(capa.scaleEntrada, 1, t), opacity: capa.opacity * t };
  }

  const hastaElFinal = capa.endSeconds - segundos;
  if (salida > 0 && hastaElFinal < salida) {
    // El avance corre al reves: en 1 esta en reposo y en 0 ya se fue.
    const t = suavizar(hastaElFinal / salida);
    return { scale: capa.scale * mezclar(capa.scaleSalida, 1, t), opacity: capa.opacity * t };
  }

  return quieta;
}

/**
 * Suaviza el avance para que arranque y frene despacio (smoothstep). Sin esto
 * la animacion se ve mecanica, sobre todo en un fundido corto.
 */
function suavizar(avance: number): number {
  const t = Math.min(1, Math.max(0, avance));
  return t * t * (3 - 2 * t);
}

function mezclar(desde: number, hasta: number, t: number): number {
  return desde + (hasta - desde) * t;
}

/**
 * En que segundo de la LINEA DE TIEMPO esta parado el visor.
 *
 * El <video> solo sabe su propio tiempo dentro del archivo. Para saber donde
 * cae eso en el montaje hay que descontarle la marca de entrada, estirarlo por
 * la velocidad y sumarle lo que duran los clips anteriores.
 */
export function tiempoEnLaLinea(
  offsetDelClip: number,
  videoTime: number,
  trimIn: number,
  speed: number,
): number {
  return offsetDelClip + (videoTime - trimIn) / (speed || 1);
}

/**
 * Como entra la capa en el lienzo.
 *
 * Usa 'contain' para que escala 1 signifique "la capa entra justo entera": es
 * la referencia mas predecible para despues agrandarla o achicarla a dedo.
 */
export function framingDeCapa(capa: {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}): Framing {
  return {
    textureWidth: capa.width,
    textureHeight: capa.height,
    rotation: 0,
    mode: 'contain',
    scale: capa.scale,
    offsetX: capa.offsetX,
    offsetY: capa.offsetY,
  };
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
