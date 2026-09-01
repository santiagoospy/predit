import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';

import { decodeAudioRange } from '../audio/decode';
import {
  clipAportaAudio,
  planMix,
  renderMix,
  sliceAudioBuffer,
  MIX_SAMPLE_RATE,
  type MixClip,
  type MixMusic,
} from '../audio/mix';
import type { Lut3D } from '../color/cube';
import { LutRenderer, type FitMode, type Framing } from '../color/renderer';
import type { ExportPreset } from './presets';

export interface ExportClip {
  file: File;
  /** Recorte, en segundos dentro del archivo original. */
  inSeconds: number;
  outSeconds: number;
  /** 1 = velocidad real. 0.5 = la mitad, o sea el doble de duracion. */
  speed: number;
  lutConv: Lut3D | null;
  lutLook: Lut3D | null;
  fit: FitMode;
  panX?: number;
  panY?: number;
  /** Volumen del sonido propio del clip, de 0 a 1. */
  volume: number;
  hasAudio: boolean;
  audioCanDecode: boolean;
}

export interface ExportProgress {
  /** 0 a 1. */
  fraction: number;
  clipIndex: number;
  clipCount: number;
  framesWritten: number;
  /** El audio se prepara entero antes de arrancar con la imagen. */
  fase: 'audio' | 'video';
}

export interface ExportOptions {
  preset: ExportPreset;
  frameRate: number;
  /** La musica que va sobre toda la linea de tiempo, ya decodificada. */
  music: MixMusic | null;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  /** Lo que salio distinto de lo pedido pero no ameritaba frenar el export. */
  avisos: string[];
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Duracion que va a tener el clip en la linea de tiempo, ya con su velocidad. */
export function outputDuration(clip: ExportClip): number {
  return Math.max(0, (clip.outSeconds - clip.inSeconds) / clip.speed);
}

/**
 * Arma el MP4 final: decodifica cada clip, lo pasa por el shader con sus LUTs y
 * su encuadre, y lo recodifica a la grilla de cuadros del proyecto.
 *
 * El corte es exacto porque decodifica en orden y cuenta cuadros, en vez de
 * confiar en la busqueda por tiempo de un <video>, que en material long-GOP
 * cae en el fotograma clave mas cercano.
 */
export async function exportClips(
  clips: ExportClip[],
  options: ExportOptions,
): Promise<ExportResult> {
  if (clips.length === 0) throw new ExportError('No hay clips para exportar.');

  const { preset, frameRate } = options;
  const totalOutputSeconds = clips.reduce((acc, c) => acc + outputDuration(c), 0);
  if (totalOutputSeconds <= 0) {
    throw new ExportError('El recorte deja los clips en cero segundos.');
  }

  const codec = await pickCodec(preset);

  // El audio se resuelve entero antes de tocar la imagen: la mezcla se hace en
  // un OfflineAudioContext, que rinde muy por encima del tiempo real, y de ahi
  // sale la pista completa lista para ir alimentando al codificador.
  const avisos: string[] = [];
  const mezcla = await prepararAudio(clips, options, avisos);

  // Un canvas propio para el export: el del visor tiene otra resolucion.
  const canvas = document.createElement('canvas');
  canvas.width = preset.width;
  canvas.height = preset.height;
  const renderer = new LutRenderer(canvas);

  const target = new BufferTarget();
  const output = new Output({
    // 'in-memory' pone el indice al principio del archivo: sin eso, algunas apps
    // tienen que descargarlo entero antes de poder abrirlo.
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate });

  const audioSource = mezcla
    ? new AudioBufferSource({ codec: mezcla.codec, quality: QUALITY_HIGH })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);
  const volcarAudio = crearVolcadoDeAudio(audioSource, mezcla?.buffer ?? null);

  try {
    await output.start();

    let framesWritten = 0;
    let timelineSeconds = 0;

    for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
      const clip = clips[clipIndex]!;
      throwIfAborted(options.signal);

      renderer.setLut('conv', clip.lutConv);
      renderer.setLut('look', clip.lutLook);

      const clipEndSeconds = timelineSeconds + outputDuration(clip);
      framesWritten = await renderClip(clip, {
        renderer,
        source,
        frameRate,
        timelineStart: timelineSeconds,
        timelineEnd: clipEndSeconds,
        framesWritten,
        signal: options.signal,
        onFrame: (written) =>
          options.onProgress?.({
            fraction: Math.min(1, written / frameRate / totalOutputSeconds),
            clipIndex,
            clipCount: clips.length,
            framesWritten: written,
            fase: 'video',
          }),
      });

      timelineSeconds = clipEndSeconds;

      // Se vuelca el audio de a tramos, a medida que la imagen avanza, para que
      // el muxer no tenga que sostener la pista entera hasta el final.
      await volcarAudio(timelineSeconds);
    }

    await volcarAudio(Infinity);
    await output.finalize();

    const buffer = target.buffer;
    if (!buffer) throw new ExportError('El codificador no devolvio ningun dato.');
    return { blob: new Blob([buffer], { type: 'video/mp4' }), avisos };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    renderer.dispose();
  }
}

interface RenderClipContext {
  renderer: LutRenderer;
  source: CanvasSource;
  frameRate: number;
  timelineStart: number;
  timelineEnd: number;
  framesWritten: number;
  signal?: AbortSignal | undefined;
  onFrame: (framesWritten: number) => void;
}

async function renderClip(clip: ExportClip, ctx: RenderClipContext): Promise<number> {
  const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new ExportError(`"${clip.file.name}" no tiene pista de video.`);
  if (!(await track.canDecode())) {
    throw new ExportError(
      `Este dispositivo no puede decodificar "${clip.file.name}" (${track.codec ?? 'codec desconocido'}).`,
    );
  }

  const [rotation, metrics] = await Promise.all([
    track.getRotation(),
    track.computeFrameRateMetrics(),
  ]);
  const fallbackDuration = 1 / (metrics.bestGuessFrameRate || 25);

  const framing: Framing = {
    // WebCodecs entrega el cuadro SIN rotar, al reves que el <video> del visor.
    textureWidth: track.codedWidth,
    textureHeight: track.codedHeight,
    rotation,
    mode: clip.fit,
    panX: clip.panX ?? 0,
    panY: clip.panY ?? 0,
  };

  const sink = new VideoSampleSink(track);
  let framesWritten = ctx.framesWritten;

  for await (const sample of sink.samples(clip.inSeconds, clip.outSeconds)) {
    throwIfAborted(ctx.signal);
    try {
      const duration = sample.duration > 0 ? sample.duration : fallbackDuration;
      // Donde cae este cuadro en la linea de tiempo, ya estirado por la velocidad.
      const sampleEnd = Math.min(
        ctx.timelineStart + (sample.timestamp + duration - clip.inSeconds) / clip.speed,
        ctx.timelineEnd,
      );

      let drawn = false;
      // Emite todos los cuadros de salida que este cuadro de origen cubre. Si
      // cubre varios, se repiten (camara lenta mas alla de lo que da el material);
      // si no cubre ninguno, se descarta (camara rapida).
      while (framesWritten / ctx.frameRate < sampleEnd) {
        if (!drawn) {
          ctx.renderer.draw(toTexture(sample), framing, false);
          drawn = true;
        }
        await ctx.source.add(framesWritten / ctx.frameRate, 1 / ctx.frameRate);
        framesWritten++;
        ctx.onFrame(framesWritten);
      }
    } finally {
      sample.close();
    }
  }

  return framesWritten;
}

/**
 * VideoFrame sirve directo como fuente de textura en WebGL. Se cierra enseguida
 * porque cada uno retiene un buffer de video sin comprimir, y en un telefono
 * acumularlos es lo que hace que Safari mate la pestana.
 */
function toTexture(sample: { toVideoFrame(): VideoFrame }): VideoFrame {
  const frame = sample.toVideoFrame();
  queueMicrotask(() => frame.close());
  return frame;
}

async function pickCodec(preset: ExportPreset): Promise<VideoCodec> {
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc'], {
    width: preset.width,
    height: preset.height,
  });
  if (!codec) {
    throw new ExportError(
      `Este dispositivo no puede codificar video de ${preset.width}×${preset.height}. ` +
        'Proba con un preset de menor resolucion.',
    );
  }
  return codec;
}

/**
 * Decodifica el sonido de los clips que aportan, lo mezcla con la musica y
 * devuelve la pista completa.
 *
 * Nada de esto es motivo para frenar un export: si el dispositivo no sabe
 * codificar audio, o si un clip suelto no se deja decodificar, el video sale
 * igual y el problema se cuenta como aviso.
 */
async function prepararAudio(
  clips: ExportClip[],
  options: ExportOptions,
  avisos: string[],
): Promise<{ buffer: AudioBuffer; codec: AudioCodec } | null> {
  const aporta = clips.map(clipAportaAudio);
  if (!options.music && !aporta.some(Boolean)) return null;

  const codec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: 2,
    sampleRate: MIX_SAMPLE_RATE,
  });
  if (!codec) {
    avisos.push('Este dispositivo no puede codificar audio, asi que el MP4 sale mudo.');
    return null;
  }

  options.onProgress?.({
    fraction: 0,
    clipIndex: 0,
    clipCount: clips.length,
    framesWritten: 0,
    fase: 'audio',
  });

  const paraMezclar: MixClip[] = [];
  for (const [i, clip] of clips.entries()) {
    throwIfAborted(options.signal);

    let buffer: AudioBuffer | null = null;
    if (aporta[i]) {
      try {
        buffer = await decodeAudioRange(clip.file, clip.inSeconds, clip.outSeconds);
      } catch (error) {
        avisos.push(
          `No pude usar el audio de "${clip.file.name}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    paraMezclar.push({
      outputDuration: outputDuration(clip),
      buffer,
      volume: clip.volume,
    });
  }

  const { events, totalSeconds } = planMix(paraMezclar, options.music);
  if (events.length === 0) return null;

  return { buffer: await renderMix(events, totalSeconds), codec };
}

/**
 * Va entregando la mezcla al codificador de a un segundo por vez. Cada llamada
 * escribe todo lo que ya quedo cubierto por la imagen; con Infinity vacia lo que
 * falte.
 */
function crearVolcadoDeAudio(
  source: AudioBufferSource | null,
  mezcla: AudioBuffer | null,
): (hastaSegundos: number) => Promise<void> {
  let escritos = 0;

  return async (hastaSegundos: number) => {
    if (!source || !mezcla) return;

    const objetivo = Math.min(
      mezcla.length,
      Math.round(Math.min(hastaSegundos, mezcla.duration) * mezcla.sampleRate),
    );
    while (escritos < objetivo) {
      const cuantos = Math.min(mezcla.sampleRate, objetivo - escritos);
      await source.add(sliceAudioBuffer(mezcla, escritos, cuantos));
      escritos += cuantos;
    }
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportError('Export cancelado.');
}

/**
 * Entrega el archivo. En iOS lo correcto es la hoja de compartir: desde ahi va a
 * Fotos, a Archivos o directo a Edits. La descarga clasica queda de respaldo
 * para el escritorio.
 */
export async function deliverExport(blob: Blob, filename: string): Promise<'compartido' | 'descargado'> {
  const file = new File([blob], filename, { type: 'video/mp4' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'compartido';
    } catch (error) {
      // Si el usuario cierra la hoja de compartir no es un error que valga la
      // pena mostrar, pero tampoco hay que caer en la descarga sin avisar.
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'compartido';
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'descargado';
}
