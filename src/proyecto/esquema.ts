/**
 * El proyecto serializado: la "receta" del montaje, sin un solo byte de video.
 *
 * El documento guarda numeros, no material: los recortes, las velocidades, el
 * reencuadre y a que LUT quedo atado cada clip. Eso son unos pocos KB.
 *
 * De cada archivo guarda ademas su HUELLA, que cumple dos funciones: es la
 * clave con la que el almacen de medios (`almacen.ts`) encuentra la copia de
 * los bytes y devuelve el montaje sin preguntar nada, y es con lo que la app
 * reconoce los archivos cuando esa copia no esta -un proyecto de antes de que
 * existiera el almacen, o uno al que ya se le libero el espacio- y hay que
 * pedirselos al usuario.
 *
 * Todo lo de este modulo es puro a proposito: no toca IndexedDB ni el DOM, asi
 * que se puede testear entero.
 */

import type { FitMode } from '../color/renderer';
import type { AjustesGiro } from '../giro/ajustes';
import { clipOutputDuration, type MusicTrack, type OverlayLayer, type TimelineClip } from '../edit/types';
import type { ExportPreset } from '../export/presets';

/**
 * Con que se reconoce un archivo cuando el usuario lo vuelve a elegir.
 *
 * No hay hash del contenido a proposito: calcularlo sobre 120 MB en un telefono
 * tarda segundos y no aporta nada frente a nombre + tamano + fecha, que ya son
 * unicos entre los clips de una tarjeta de camara.
 */
export interface HuellaArchivo {
  nombre: string;
  tamano: number;
  /** `File.lastModified`, en milisegundos. */
  fecha: number;
}

export function huellaDe(file: File): HuellaArchivo {
  return { nombre: file.name, tamano: file.size, fecha: file.lastModified };
}

/**
 * La clave con la que se guarda y se busca la copia de un archivo.
 *
 * Es la mas estricta de las tres formas de reconocer un archivo (ver CLAVES mas
 * abajo): aca no hay lugar para corazonadas, porque una coincidencia floja
 * devolveria bytes que no son los del clip. Como es deterministica a partir de
 * la huella, el documento del proyecto no guarda ninguna referencia extra: el
 * mismo archivo importado dos veces, o un clip partido en dos, caen sobre la
 * misma clave y comparten una sola copia.
 */
export function claveMedio(h: HuellaArchivo): string {
  return `${h.nombre.toLowerCase()}|${h.tamano}|${h.fecha}`;
}

/** Un clip guardado: todo `TimelineClip` menos el archivo, la url y los avisos. */
export interface ClipDoc {
  id: string;
  huella: HuellaArchivo;
  lutConvId: string | null;
  lutLookId: string | null;
  /**
   * La correccion primaria. Opcionales al LEER: un proyecto guardado antes de que
   * el color existiera no los trae. Al escribir siempre salen los tres.
   *
   * Que el tipo lo diga no es prolijidad: obliga a que quien los lea pase por
   * sanearGrade() en vez de mandarle un undefined a la GPU.
   */
  lift?: number;
  gamma?: number;
  gain?: number;
  fit: FitMode;
  panX: number;
  panY: number;
  speed: number;
  trimIn: number;
  trimOut: number;
  volume: number;
  /**
   * Como se estabiliza. Opcional al LEER, igual que el grade: un proyecto
   * guardado antes de que existiera la estabilizacion no lo trae, y quien lo
   * lea tiene que pasar por sanearAjustes() en vez de confiar en que este.
   */
  giro?: AjustesGiro;
}

/** La musica guardada: sus marcas y de donde salio, sin el AudioBuffer. */
export interface MusicDoc {
  id: string;
  name: string;
  origen: 'archivo' | 'clip';
  huella: HuellaArchivo;
  /**
   * Si salio de un clip, cual. Sin esto, re-vincular el video no alcanzaria
   * para rearmar la musica y el usuario tendria que elegir el mismo archivo
   * dos veces.
   */
  clipId: string | null;
  startInMusic: number;
  endInMusic: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

/** La capa guardada: sus tiempos y su animacion, sin el ImageBitmap. */
export interface CapaDoc {
  id: string;
  name: string;
  huella: HuellaArchivo;
  startSeconds: number;
  endSeconds: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  opacity: number;
  entradaSeconds: number;
  salidaSeconds: number;
  scaleEntrada: number;
  scaleSalida: number;
}

export interface ProyectoDoc {
  /** Sube si el formato cambia de forma incompatible. Hoy solo existe la 1. */
  version: 1;
  id: string;
  nombre: string;
  /** Cuando se guardo, en milisegundos desde la epoca. */
  actualizado: number;
  presetId: string;
  selectedId: string | null;
  clips: ClipDoc[];
  /** Ids de la biblioteca global de LUTs que este montaje usa. */
  luts: string[];
  music: MusicDoc | null;
  capa: CapaDoc | null;
}

/** El nombre que lleva un proyecto al que todavia no se le puso ninguno. */
export const NOMBRE_SIN_TITULO = 'sin titulo';

/** El estado del editor que vale la pena guardar. */
export interface EstadoProyecto {
  id: string;
  nombre: string;
  clips: TimelineClip[];
  music: MusicTrack | null;
  capa: OverlayLayer | null;
  preset: ExportPreset;
  selectedId: string | null;
}

export function serializarProyecto(estado: EstadoProyecto, ahora = Date.now()): ProyectoDoc {
  const usados = new Set<string>();
  for (const c of estado.clips) {
    if (c.lutConvId) usados.add(c.lutConvId);
    if (c.lutLookId) usados.add(c.lutLookId);
  }

  const music = estado.music;
  const capa = estado.capa;

  return {
    version: 1,
    id: estado.id,
    nombre: estado.nombre,
    actualizado: ahora,
    presetId: estado.preset.id,
    selectedId: estado.selectedId,
    luts: [...usados],
    clips: estado.clips.map((c) => ({
      id: c.id,
      huella: huellaDe(c.file),
      lutConvId: c.lutConvId,
      lutLookId: c.lutLookId,
      lift: c.lift,
      gamma: c.gamma,
      gain: c.gain,
      fit: c.fit,
      panX: c.panX,
      panY: c.panY,
      speed: c.speed,
      trimIn: c.trimIn,
      trimOut: c.trimOut,
      volume: c.volume,
      giro: c.giro,
    })),
    music: music
      ? {
          id: music.id,
          name: music.name,
          origen: music.origen,
          huella: music.huella,
          clipId: music.clipId,
          startInMusic: music.startInMusic,
          endInMusic: music.endInMusic,
          volume: music.volume,
          fadeIn: music.fadeIn,
          fadeOut: music.fadeOut,
        }
      : null,
    capa: capa
      ? {
          id: capa.id,
          name: capa.name,
          huella: capa.huella,
          startSeconds: capa.startSeconds,
          endSeconds: capa.endSeconds,
          scale: capa.scale,
          offsetX: capa.offsetX,
          offsetY: capa.offsetY,
          opacity: capa.opacity,
          entradaSeconds: capa.entradaSeconds,
          salidaSeconds: capa.salidaSeconds,
          scaleEntrada: capa.scaleEntrada,
          scaleSalida: capa.scaleSalida,
        }
      : null,
  };
}

/** Si dos documentos guardan el mismo montaje, sin mirar la fecha de guardado. */
export function mismoContenido(a: ProyectoDoc | null, b: ProyectoDoc | null): boolean {
  if (a === null || b === null) return a === b;
  const sinFecha = (d: ProyectoDoc) => JSON.stringify({ ...d, actualizado: 0 });
  return sinFecha(a) === sinFecha(b);
}

export type TipoFaltante = 'clip' | 'musica' | 'capa';

/** Un archivo que el proyecto necesita y todavia no tiene. */
export interface Faltante {
  /** Donde va el archivo: el id del clip, o 'musica' / 'capa'. */
  slot: string;
  tipo: TipoFaltante;
  huella: HuellaArchivo;
}

export const SLOT_MUSICA = 'musica';
export const SLOT_CAPA = 'capa';

/**
 * Que archivos hay que pedirle al usuario para poder abrir el proyecto.
 *
 * La musica sacada de un clip NO figura: su archivo es el del clip, que ya esta
 * en la lista, y pedirlo de nuevo seria pedir el mismo video dos veces.
 */
export function faltantes(doc: ProyectoDoc): Faltante[] {
  const lista: Faltante[] = doc.clips.map((c) => ({
    slot: c.id,
    tipo: 'clip' as const,
    huella: c.huella,
  }));

  const music = doc.music;
  const musicaSaleDeUnClip =
    music !== null &&
    music.origen === 'clip' &&
    music.clipId !== null &&
    doc.clips.some((c) => c.id === music.clipId);

  if (music && !musicaSaleDeUnClip) {
    lista.push({ slot: SLOT_MUSICA, tipo: 'musica', huella: music.huella });
  }
  if (doc.capa) {
    lista.push({ slot: SLOT_CAPA, tipo: 'capa', huella: doc.capa.huella });
  }
  return lista;
}

/**
 * Las claves del almacen de medios que este proyecto necesita.
 *
 * Sale de `faltantes` y no de los clips directamente para que sea exactamente
 * el mismo conjunto que la app pediria a mano: la musica sacada de un clip no
 * suma una copia aparte, porque su archivo es el del clip.
 */
export function mediosDe(doc: ProyectoDoc): string[] {
  return [...new Set(faltantes(doc).map((f) => claveMedio(f.huella)))];
}

export interface Emparejamiento {
  /** Del slot al archivo que le toca. */
  asignados: Map<string, File>;
  /** Los que el usuario eligio y no entraron en ningun lugar. */
  sobrantes: File[];
}

/**
 * Las tres formas de reconocer un archivo, de la mas estricta a la mas laxa.
 *
 * La fecha se afloja primero porque es lo que mas se pierde en el camino: pasar
 * un video por AirDrop o por el carrete de Fotos le cambia el `lastModified`
 * pero no el tamano. El nombre queda de ultimo recurso, para el caso de un
 * archivo recomprimido.
 */
const CLAVES: ((h: HuellaArchivo) => string)[] = [
  claveMedio,
  (h) => `${h.nombre.toLowerCase()}|${h.tamano}`,
  (h) => h.nombre.toLowerCase(),
];

/**
 * Reparte los archivos que eligio el usuario entre los lugares que los esperan.
 *
 * Un archivo puede llenar VARIOS lugares, pero solo si la huella coincide
 * entera: es el caso de un clip partido en dos, donde los dos pedazos son
 * literalmente el mismo video y pedirlo dos veces seria absurdo.
 *
 * Con las claves laxas se sigue gastando un archivo por lugar. Ahi la
 * coincidencia es una corazonada -mismo nombre, otra fecha- y repartir un solo
 * archivo entre varios lugares podria llenarlos todos con el video equivocado.
 */
export function emparejar(pendientes: Faltante[], files: File[]): Emparejamiento {
  const asignados = new Map<string, File>();
  const libres = files.map((file) => ({ file, tomado: false }));

  for (const [nivel, clave] of CLAVES.entries()) {
    const exacta = nivel === 0;
    for (const pendiente of pendientes) {
      if (asignados.has(pendiente.slot)) continue;
      const buscado = clave(pendiente.huella);
      const candidato = libres.find(
        (l) => (exacta || !l.tomado) && clave(huellaDe(l.file)) === buscado,
      );
      if (candidato) {
        candidato.tomado = true;
        asignados.set(pendiente.slot, candidato.file);
      }
    }
  }

  return { asignados, sobrantes: libres.filter((l) => !l.tomado).map((l) => l.file) };
}

/** Lo que se muestra de un proyecto en la lista, sin abrirlo. */
export interface ResumenProyecto {
  id: string;
  nombre: string;
  actualizado: number;
  clips: number;
  duracionSeconds: number;
}

export function resumir(doc: ProyectoDoc): ResumenProyecto {
  return {
    id: doc.id,
    nombre: doc.nombre,
    actualizado: doc.actualizado,
    clips: doc.clips.length,
    duracionSeconds: doc.clips.reduce((acc, c) => acc + clipOutputDuration(c), 0),
  };
}

/** "hace 4 minutos", para el cartel de sesion cortada y la lista. */
export function haceCuanto(desde: number, ahora = Date.now()): string {
  const segundos = Math.max(0, Math.round((ahora - desde) / 1000));
  if (segundos < 60) return 'recién';
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `hace ${minutos} minuto${minutos === 1 ? '' : 's'}`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.round(horas / 24);
  return `hace ${dias} día${dias === 1 ? '' : 's'}`;
}

/** La hora del ultimo guardado, para el indicador del encabezado. */
export function horaCorta(momento: number): string {
  const d = new Date(momento);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}
