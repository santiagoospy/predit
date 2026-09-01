/**
 * La mezcla de audio del proyecto: una pista de musica sobre toda la linea de
 * tiempo, y debajo el sonido propio de cada clip.
 *
 * Esta partido en dos mitades a proposito. `planMix` es aritmetica pura y se
 * puede probar sin navegador; `renderMix` solo ejecuta ese plan contra Web
 * Audio, que en los tests no existe.
 */

/** Todo se mezcla a esta frecuencia; Web Audio reresamplea lo que venga distinto. */
export const MIX_SAMPLE_RATE = 48000;

/**
 * Fundido cortito en los bordes de cada clip. Sin esto, un corte en mitad de una
 * onda suena como un chasquido.
 */
export const CLIP_EDGE_FADE = 0.01;

export interface MixEvent {
  buffer: AudioBuffer;
  /** Segundo de la linea de tiempo en el que empieza a sonar. */
  timelineStart: number;
  /** Desde que segundo del buffer se lee. */
  offsetInBuffer: number;
  /** Cuanto suena, en segundos. */
  duration: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

export interface MixClip {
  /** Lo que ocupa el clip en la salida, ya con su velocidad aplicada. */
  outputDuration: number;
  /** Su audio ya decodificado y recortado, o null si el clip no aporta sonido. */
  buffer: AudioBuffer | null;
  volume: number;
}

export interface MixMusic {
  buffer: AudioBuffer;
  /** Desde que segundo del tema arranca la musica en la linea de tiempo. */
  startInMusic: number;
  /** En que segundo del tema corta. */
  endInMusic: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * Un clip aporta su audio solo si suena a velocidad real. Estirar o comprimir el
 * sonido junto con la imagen lo desafina (la voz queda grave o de ardilla), asi
 * que en camara lenta o rapida se silencia y se avisa en pantalla.
 */
export function clipAportaAudio(clip: {
  hasAudio: boolean;
  audioCanDecode: boolean;
  volume: number;
  speed: number;
}): boolean {
  return (
    clip.hasAudio &&
    clip.audioCanDecode &&
    clip.volume > 0 &&
    Math.abs(clip.speed - 1) < 1e-6
  );
}

/**
 * Ubica cada fuente en la linea de tiempo. Los clips van uno detras de otro, en
 * el mismo orden y con las mismas duraciones que el video; la musica va desde el
 * segundo cero y se corta cuando se termina el proyecto.
 */
export function planMix(
  clips: MixClip[],
  music: MixMusic | null,
): { events: MixEvent[]; totalSeconds: number } {
  const events: MixEvent[] = [];
  let timeline = 0;

  for (const clip of clips) {
    const inicio = timeline;
    timeline += clip.outputDuration;

    if (!clip.buffer || clip.volume <= 0) continue;

    // Si el audio decodificado es mas corto que el tramo de video (pasa cuando la
    // pista de audio termina antes que la de video), el resto queda en silencio.
    const duracion = Math.min(clip.buffer.duration, clip.outputDuration);
    if (duracion <= 0) continue;

    const borde = Math.min(CLIP_EDGE_FADE, duracion / 2);
    events.push({
      buffer: clip.buffer,
      timelineStart: inicio,
      offsetInBuffer: 0,
      duration: duracion,
      gain: clip.volume,
      fadeIn: borde,
      fadeOut: borde,
    });
  }

  const totalSeconds = timeline;

  if (music && music.volume > 0 && totalSeconds > 0) {
    const offset = Math.max(0, Math.min(music.startInMusic, music.buffer.duration));
    // La salida marcada, sin pasarse ni del archivo ni de la entrada.
    const hasta = Math.max(offset, Math.min(music.endInMusic, music.buffer.duration));
    // El pedazo elegido del tema, sin pasarse del largo del video.
    const duracion = Math.min(hasta - offset, totalSeconds);
    if (duracion > 0) {
      const mitad = duracion / 2;
      events.push({
        buffer: music.buffer,
        timelineStart: 0,
        offsetInBuffer: offset,
        duration: duracion,
        gain: music.volume,
        fadeIn: Math.min(Math.max(0, music.fadeIn), mitad),
        fadeOut: Math.min(Math.max(0, music.fadeOut), mitad),
      });
    }
  }

  return { events, totalSeconds };
}

/** Ejecuta el plan y devuelve la mezcla entera como un solo AudioBuffer. */
export async function renderMix(events: MixEvent[], totalSeconds: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.max(1, Math.ceil(totalSeconds * MIX_SAMPLE_RATE)),
    sampleRate: MIX_SAMPLE_RATE,
  });

  for (const ev of events) {
    const fuente = ctx.createBufferSource();
    fuente.buffer = ev.buffer;

    const ganancia = ctx.createGain();
    aplicarFundidos(ganancia.gain, ev);

    fuente.connect(ganancia).connect(ctx.destination);
    fuente.start(ev.timelineStart, ev.offsetInBuffer, ev.duration);
  }

  return ctx.startRendering();
}

function aplicarFundidos(param: AudioParam, ev: MixEvent): void {
  const fin = ev.timelineStart + ev.duration;
  const entrada = Math.min(ev.fadeIn, ev.duration / 2);
  const salida = Math.min(ev.fadeOut, ev.duration / 2);

  param.setValueAtTime(entrada > 0 ? 0 : ev.gain, ev.timelineStart);
  if (entrada > 0) param.linearRampToValueAtTime(ev.gain, ev.timelineStart + entrada);
  if (salida > 0) {
    param.setValueAtTime(ev.gain, fin - salida);
    param.linearRampToValueAtTime(0, fin);
  }
}

/**
 * Recorta un pedazo de la mezcla. El codificador se alimenta de a tramos cortos
 * para no tener que sostener toda la pista de audio en memoria de una sola vez.
 */
export function sliceAudioBuffer(
  buffer: AudioBuffer,
  desdeFrame: number,
  cuantosFrames: number,
): AudioBuffer {
  const salida = new AudioBuffer({
    length: cuantosFrames,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let canal = 0; canal < buffer.numberOfChannels; canal++) {
    salida
      .getChannelData(canal)
      .set(buffer.getChannelData(canal).subarray(desdeFrame, desdeFrame + cuantosFrames));
  }
  return salida;
}
