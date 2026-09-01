import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';

/**
 * Tope de material que se decodifica de una. Un AudioBuffer es float32 sin
 * comprimir: 15 minutos en estereo a 48 kHz son unos 350 MB, y arriba de eso
 * Safari mata la pestana en el telefono.
 */
export const MAX_AUDIO_SECONDS = 15 * 60;

export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioError';
  }
}

/**
 * Decodifica un tramo de audio a un AudioBuffer, listo tanto para escucharlo
 * con Web Audio como para mezclarlo en el export.
 *
 * Sirve igual para un .mp3 suelto, un .wav o el audio adentro de un MP4: la
 * lista ALL_FORMATS de mediabunny cubre los tres, asi que "importar un mp3" y
 * "extraer el audio de un video" terminan siendo el mismo camino de codigo.
 */
export async function decodeAudioRange(
  file: File,
  start = 0,
  end?: number,
): Promise<AudioBuffer> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  const track = await input.getPrimaryAudioTrack();
  if (!track) {
    throw new AudioError(`"${file.name}" no tiene pista de audio.`);
  }
  if (!(await track.canDecode())) {
    throw new AudioError(
      `Este dispositivo no puede decodificar el audio de "${file.name}" ` +
        `(${(await track.getCodec()) ?? 'codec desconocido'}).`,
    );
  }

  const [sampleRate, numberOfChannels, duracion] = await Promise.all([
    track.getSampleRate(),
    track.getNumberOfChannels(),
    input.computeDuration(),
  ]);

  const desde = Math.max(0, start);
  const hasta = Math.min(end ?? duracion, duracion);
  const segundos = hasta - desde;

  if (segundos <= 0) {
    throw new AudioError(`El tramo de audio de "${file.name}" queda en cero segundos.`);
  }
  if (segundos > MAX_AUDIO_SECONDS) {
    throw new AudioError(
      `"${file.name}" dura ${Math.round(segundos / 60)} minutos y no entra en la memoria del ` +
        `telefono. El maximo es ${MAX_AUDIO_SECONDS / 60} minutos: recorta el archivo antes de importarlo.`,
    );
  }

  const salida = new AudioBuffer({
    length: Math.ceil(segundos * sampleRate),
    numberOfChannels,
    sampleRate,
  });

  // Cada trozo se copia en su posicion real, calculada desde su marca de tiempo:
  // si el decodificador deja un hueco, ahi queda silencio en vez de correrse todo
  // lo que viene despues.
  const sink = new AudioBufferSink(track);
  for await (const { buffer, timestamp } of sink.buffers(desde, hasta)) {
    const offset = Math.round((timestamp - desde) * sampleRate);
    for (let canal = 0; canal < salida.numberOfChannels; canal++) {
      const origen = buffer.getChannelData(Math.min(canal, buffer.numberOfChannels - 1));
      const destino = salida.getChannelData(canal);

      // El primer trozo suele empezar antes del corte pedido: se descarta esa punta.
      let desdeOrigen = 0;
      let desdeDestino = offset;
      if (desdeDestino < 0) {
        desdeOrigen = -desdeDestino;
        desdeDestino = 0;
      }

      const cuantos = Math.min(origen.length - desdeOrigen, destino.length - desdeDestino);
      if (cuantos > 0) {
        destino.set(origen.subarray(desdeOrigen, desdeOrigen + cuantos), desdeDestino);
      }
    }
  }

  return salida;
}
