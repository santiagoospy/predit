/**
 * De la receta guardada al editor: reconstruye el estado con los archivos que
 * el usuario acaba de volver a elegir.
 *
 * Es el unico lugar donde se rearman las tres cosas que no se pueden guardar
 * (el File del clip, el AudioBuffer de la musica y el ImageBitmap de la capa),
 * y lo hace con las mismas funciones que usa la importacion normal: un clip
 * re-vinculado pasa por `probeClip` igual que uno recien importado, asi que sus
 * avisos y su diagnostico salen del archivo real y no de lo que quedo escrito.
 *
 * Nada de esto tira una excepcion hacia afuera. Si un clip no se puede abrir se
 * cae ese clip y el resto del montaje entra igual: perder un clip es molesto,
 * perder el montaje entero por un clip es peor.
 */

import { decodeAudioRange } from '../audio/decode';
import type { LibraryLut, MusicTrack, OverlayLayer, TimelineClip } from '../edit/types';
import { DEFAULT_PRESET, EXPORT_PRESETS, type ExportPreset } from '../export/presets';
import { cargarImagen } from '../media/imagen';
import { clipWarnings, probeClip } from '../media/probe';
import { SLOT_CAPA, SLOT_MUSICA, type ClipDoc, type ProyectoDoc } from './esquema';

export interface EstadoRestaurado {
  clips: TimelineClip[];
  music: MusicTrack | null;
  capa: OverlayLayer | null;
  preset: ExportPreset;
  selectedId: string | null;
  /** Lo que no se pudo rearmar, en castellano y listo para mostrar. */
  avisos: string[];
}

function comoTexto(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Acota las marcas de recorte a la duracion del archivo elegido.
 *
 * Hace falta porque el usuario puede elegir otro archivo con el mismo nombre:
 * una version recomprimida, mas corta. Sin esto el recorte apuntaria a un
 * segundo que ya no existe y el visor quedaria en negro.
 */
function acotarRecorte(guardado: ClipDoc, duracion: number): { trimIn: number; trimOut: number } {
  const trimIn = Math.min(Math.max(0, guardado.trimIn), duracion);
  const trimOut = Math.min(Math.max(trimIn, guardado.trimOut), duracion);
  return { trimIn, trimOut };
}

export async function reconstruir(
  doc: ProyectoDoc,
  asignados: Map<string, File>,
  biblioteca: LibraryLut[],
): Promise<EstadoRestaurado> {
  const avisos: string[] = [];
  const clips: TimelineClip[] = [];

  const hayLut = (id: string | null): string | null => {
    if (id === null) return null;
    if (biblioteca.some((l) => l.id === id)) return id;
    return null;
  };
  let lutsPerdidos = 0;

  for (const guardado of doc.clips) {
    const file = asignados.get(guardado.id);
    if (!file) {
      avisos.push(`Falto el archivo de "${guardado.huella.nombre}": ese clip no entro al montaje.`);
      continue;
    }
    try {
      const info = await probeClip(file);
      const { trimIn, trimOut } = acotarRecorte(guardado, info.durationSeconds);
      if (Math.abs(trimOut - guardado.trimOut) > 0.05 || Math.abs(trimIn - guardado.trimIn) > 0.05) {
        avisos.push(
          `"${file.name}" dura ${info.durationSeconds.toFixed(1)}s y el recorte guardado no entraba: ` +
            'se acorto a lo que hay.',
        );
      }
      const conv = hayLut(guardado.lutConvId);
      const look = hayLut(guardado.lutLookId);
      if (conv !== guardado.lutConvId || look !== guardado.lutLookId) lutsPerdidos += 1;

      clips.push({
        id: guardado.id,
        file,
        url: URL.createObjectURL(file),
        info,
        warnings: clipWarnings(info),
        lutConvId: conv,
        lutLookId: look,
        fit: guardado.fit,
        panX: guardado.panX,
        panY: guardado.panY,
        speed: guardado.speed,
        trimIn,
        trimOut,
        volume: guardado.volume,
      });
    } catch (e) {
      avisos.push(`No pude reabrir "${file.name}": ${comoTexto(e)}`);
    }
  }

  if (lutsPerdidos > 0) {
    avisos.push(
      `${lutsPerdidos} clip${lutsPerdidos === 1 ? '' : 's'} tenía un LUT que ya no está en la ` +
        'biblioteca: quedó sin LUT, hay que volver a asignarlo.',
    );
  }

  const music = await rearmarMusica(doc, asignados, avisos);
  const capa = await rearmarCapa(doc, asignados, avisos);

  const preset = EXPORT_PRESETS.find((p) => p.id === doc.presetId) ?? DEFAULT_PRESET;
  if (preset.id !== doc.presetId) {
    avisos.push(`El proyecto se guardó con una salida que ya no existe: quedó en ${preset.slug}.`);
  }

  const seleccionado = clips.some((c) => c.id === doc.selectedId) ? doc.selectedId : null;

  return {
    clips,
    music,
    capa,
    preset,
    selectedId: seleccionado ?? clips[0]?.id ?? null,
    avisos,
  };
}

async function rearmarMusica(
  doc: ProyectoDoc,
  asignados: Map<string, File>,
  avisos: string[],
): Promise<MusicTrack | null> {
  const guardada = doc.music;
  if (!guardada) return null;

  // Si el tema salio de un clip, su archivo es el del clip: no se pide aparte.
  const file =
    asignados.get(SLOT_MUSICA) ?? (guardada.clipId ? asignados.get(guardada.clipId) : undefined);
  if (!file) {
    avisos.push(`Faltó el archivo de la música ("${guardada.huella.nombre}"): quedó sin música.`);
    return null;
  }

  try {
    const buffer = await decodeAudioRange(file);
    const startInMusic = Math.min(Math.max(0, guardada.startInMusic), buffer.duration);
    const endInMusic = Math.min(Math.max(startInMusic, guardada.endInMusic), buffer.duration);
    return {
      id: guardada.id,
      name: guardada.name,
      origen: guardada.origen,
      huella: guardada.huella,
      clipId: guardada.clipId,
      buffer,
      duracionSeconds: buffer.duration,
      startInMusic,
      endInMusic,
      volume: guardada.volume,
      fadeIn: guardada.fadeIn,
      fadeOut: guardada.fadeOut,
    };
  } catch (e) {
    avisos.push(`No pude reabrir la música: ${comoTexto(e)}`);
    return null;
  }
}

async function rearmarCapa(
  doc: ProyectoDoc,
  asignados: Map<string, File>,
  avisos: string[],
): Promise<OverlayLayer | null> {
  const guardada = doc.capa;
  if (!guardada) return null;

  const file = asignados.get(SLOT_CAPA);
  if (!file) {
    avisos.push(`Faltó la imagen de la capa ("${guardada.huella.nombre}"): quedó sin capa.`);
    return null;
  }

  try {
    const imagen = await cargarImagen(file);
    return {
      id: guardada.id,
      name: guardada.name,
      huella: guardada.huella,
      bitmap: imagen.bitmap,
      width: imagen.width,
      height: imagen.height,
      startSeconds: guardada.startSeconds,
      endSeconds: guardada.endSeconds,
      scale: guardada.scale,
      offsetX: guardada.offsetX,
      offsetY: guardada.offsetY,
      opacity: guardada.opacity,
      entradaSeconds: guardada.entradaSeconds,
      salidaSeconds: guardada.salidaSeconds,
      scaleEntrada: guardada.scaleEntrada,
      scaleSalida: guardada.scaleSalida,
    };
  } catch (e) {
    avisos.push(`No pude reabrir la capa: ${comoTexto(e)}`);
    return null;
  }
}
