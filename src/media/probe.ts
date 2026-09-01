import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export interface ClipInfo {
  name: string;
  sizeBytes: number;
  /** 'avc' para la FX6, 'hevc' para GoPro y DJI. */
  codec: string | null;
  codecString: string | null;
  /** Ya con la rotacion y la relacion de aspecto de pixel aplicadas. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  frameRate: number;
  frameRateIsConstant: boolean;
  durationSeconds: number;
  colorSpace: VideoColorSpaceInit;
  /** El aviso importante: si es HDR, Safari le aplica su propio mapeo de tonos. */
  isHdr: boolean;
  canDecode: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioCanDecode: boolean;
}

export class UnsupportedClipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedClipError';
  }
}

/**
 * Lee los metadatos de un clip sin decodificarlo entero.
 *
 * Lo que mas importa aca es `colorSpace` e `isHdr`: si un clip viene etiquetado
 * como HLG o PQ, el navegador le aplica un mapeo de tonos ANTES de que la imagen
 * llegue al shader, y el LUT trabajaria sobre una imagen ya alterada. La app
 * tiene que avisarlo en vez de mostrar un color equivocado en silencio.
 */
export async function probeClip(file: File): Promise<ClipInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    throw new UnsupportedClipError(
      `"${file.name}" no tiene pista de video. Si es un MXF de la FX6, el telefono no puede abrirlo: ` +
        'usa el proxy MP4 que graba la camara al lado.',
    );
  }

  const [colorSpace, isHdr, canDecode, codecString, rotation, metrics, durationSeconds] =
    await Promise.all([
      track.getColorSpace(),
      track.hasHighDynamicRange(),
      track.canDecode(),
      track.getCodecParameterString(),
      track.getRotation(),
      track.computeFrameRateMetrics(),
      input.computeDuration(),
    ]);

  const audioTrack = await input.getPrimaryAudioTrack();
  const audio = audioTrack
    ? await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getSampleRate(),
        audioTrack.getNumberOfChannels(),
        audioTrack.canDecode(),
      ])
    : null;

  return {
    name: file.name,
    sizeBytes: file.size,
    codec: track.codec,
    codecString,
    displayWidth: track.displayWidth,
    displayHeight: track.displayHeight,
    rotation,
    frameRate: metrics.bestGuessFrameRate,
    frameRateIsConstant: metrics.frameRateIsConstant,
    durationSeconds,
    colorSpace,
    isHdr,
    canDecode,
    hasAudio: audio !== null,
    audioCodec: audio?.[0] ?? null,
    audioSampleRate: audio?.[1] ?? null,
    audioChannels: audio?.[2] ?? null,
    audioCanDecode: audio?.[3] ?? false,
  };
}

/**
 * Traduce el diagnostico a algo accionable en pantalla. Devuelve la lista de
 * avisos que hay que mostrarle al usuario, en castellano.
 */
export function clipWarnings(info: ClipInfo): string[] {
  const warnings: string[] = [];

  if (!info.canDecode) {
    warnings.push(
      `Este dispositivo no puede decodificar ${info.codec ?? 'este codec'}. ` +
        'El clip no se va a poder ver ni exportar.',
    );
  }

  if (info.isHdr) {
    warnings.push(
      'El clip esta etiquetado como HDR (HLG o PQ). El navegador le aplica su propio mapeo de tonos ' +
        'antes de que llegue al LUT, asi que el color que ves puede no ser el real. ' +
        'Conviene grabar en log con etiqueta Rec.709.',
    );
  }

  const transfer = info.colorSpace.transfer;
  if (transfer && transfer !== 'bt709' && transfer !== 'iec61966-2-1') {
    warnings.push(`Curva de transferencia inusual: "${transfer}". Verifica el color contra la camara.`);
  }

  if (info.hasAudio && !info.audioCanDecode) {
    warnings.push(
      `Este dispositivo no puede decodificar el audio del clip (${info.audioCodec ?? 'codec desconocido'}). ` +
        'El clip va a salir mudo, pero la imagen se exporta igual.',
    );
  }

  if (!info.frameRateIsConstant) {
    warnings.push(
      'El clip tiene cuadros a intervalos irregulares (VFR). Los cortes y la velocidad ' +
        'pueden correrse unos cuadros.',
    );
  }

  return warnings;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
