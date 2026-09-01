import { describe, expect, it } from 'vitest';
import { clipAportaAudio, planMix, type MixClip, type MixMusic } from './mix';

/**
 * `planMix` solo mira la duracion de cada buffer, asi que se puede probar sin
 * Web Audio: alcanza con un objeto que diga cuanto dura.
 */
function buffer(segundos: number): AudioBuffer {
  return { duration: segundos } as AudioBuffer;
}

function clip(outputDuration: number, opciones: Partial<MixClip> = {}): MixClip {
  return {
    outputDuration,
    buffer: buffer(outputDuration),
    volume: 1,
    ...opciones,
  };
}

const musica = (segundos: number, opciones: Partial<MixMusic> = {}): MixMusic => ({
  buffer: buffer(segundos),
  startInMusic: 0,
  volume: 0.8,
  fadeIn: 0,
  fadeOut: 1.5,
  ...opciones,
});

describe('clipAportaAudio', () => {
  const base = { hasAudio: true, audioCanDecode: true, volume: 1, speed: 1 };

  it('un clip normal con sonido aporta', () => {
    expect(clipAportaAudio(base)).toBe(true);
  });

  it('con la velocidad cambiada no aporta: estirarlo lo desafinaria', () => {
    expect(clipAportaAudio({ ...base, speed: 0.5 })).toBe(false);
    expect(clipAportaAudio({ ...base, speed: 2 })).toBe(false);
  });

  it('sin pista de audio, o sin poder decodificarla, no aporta', () => {
    expect(clipAportaAudio({ ...base, hasAudio: false })).toBe(false);
    expect(clipAportaAudio({ ...base, audioCanDecode: false })).toBe(false);
  });

  it('en silencio no aporta', () => {
    expect(clipAportaAudio({ ...base, volume: 0 })).toBe(false);
  });
});

describe('planMix', () => {
  it('encadena los clips en el orden de la linea de tiempo', () => {
    const { events, totalSeconds } = planMix([clip(4), clip(3), clip(2)], null);

    expect(totalSeconds).toBe(9);
    expect(events.map((e) => e.timelineStart)).toEqual([0, 4, 7]);
    expect(events.map((e) => e.duration)).toEqual([4, 3, 2]);
  });

  it('un clip en camara lenta ocupa su lugar aunque no suene', () => {
    // Dos segundos de material a 0.5x ocupan cuatro en la salida, y su audio se
    // silencia: el clip que sigue tiene que arrancar en el segundo 4 igual.
    const lento: MixClip = { outputDuration: 4, buffer: null, volume: 1 };
    const { events, totalSeconds } = planMix([lento, clip(3)], null);

    expect(totalSeconds).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0]!.timelineStart).toBe(4);
  });

  it('un clip en silencio no genera evento', () => {
    const { events } = planMix([clip(4, { volume: 0 })], null);
    expect(events).toHaveLength(0);
  });

  it('si el audio del clip es mas corto que el video, suena lo que hay', () => {
    const { events } = planMix([clip(5, { buffer: buffer(3) })], null);
    expect(events[0]!.duration).toBe(3);
  });

  it('cada clip lleva un fundido cortito en los bordes para que el corte no chasquee', () => {
    const { events } = planMix([clip(4)], null);
    expect(events[0]!.fadeIn).toBeGreaterThan(0);
    expect(events[0]!.fadeOut).toBeGreaterThan(0);
    expect(events[0]!.fadeIn).toBeLessThan(0.05);
  });

  it('la musica arranca en cero y se corta cuando termina el video', () => {
    const { events } = planMix([clip(4), clip(3)], musica(180));
    const pista = events.at(-1)!;

    expect(pista.timelineStart).toBe(0);
    expect(pista.offsetInBuffer).toBe(0);
    expect(pista.duration).toBe(7);
    expect(pista.gain).toBe(0.8);
  });

  it('respeta desde que segundo del tema arranca', () => {
    const { events } = planMix([clip(10)], musica(180, { startInMusic: 42 }));
    const pista = events.at(-1)!;

    expect(pista.offsetInBuffer).toBe(42);
    expect(pista.duration).toBe(10);
  });

  it('si el tema es mas corto que el video, el resto queda en silencio', () => {
    const { events } = planMix([clip(60)], musica(20));
    expect(events.at(-1)!.duration).toBe(20);
  });

  it('si el tema se termina justo antes del final, dura solo lo que le queda', () => {
    const { events } = planMix([clip(60)], musica(30, { startInMusic: 25 }));
    expect(events.at(-1)!.duration).toBe(5);
  });

  it('no genera pista si la musica arranca despues del final del tema', () => {
    const { events } = planMix([clip(60)], musica(30, { startInMusic: 30 }));
    expect(events).toHaveLength(1); // solo el clip
  });

  it('recorta los fundidos para que no se pisen en un tema corto', () => {
    const { events } = planMix([clip(2)], musica(2, { fadeIn: 5, fadeOut: 5 }));
    const pista = events.at(-1)!;

    expect(pista.fadeIn).toBe(1);
    expect(pista.fadeOut).toBe(1);
  });

  it('sin clips no hay nada que mezclar', () => {
    const { events, totalSeconds } = planMix([], musica(180));
    expect(totalSeconds).toBe(0);
    expect(events).toHaveLength(0);
  });
});
