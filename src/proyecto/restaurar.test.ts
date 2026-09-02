import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryLut } from '../edit/types';
import { DEFAULT_PRESET, EXPORT_PRESETS } from '../export/presets';
import type { ClipInfo } from '../media/probe';
import type { ProyectoDoc } from './esquema';
import { SLOT_CAPA, SLOT_MUSICA } from './esquema';
import { reconstruir } from './restaurar';

// Los tres unicos caminos que tocan el navegador se reemplazan; el resto de
// `reconstruir` (que es donde estan las reglas) corre de verdad.
vi.mock('../media/probe', async (original) => ({
  ...(await original<typeof import('../media/probe')>()),
  probeClip: vi.fn(),
}));
vi.mock('../audio/decode', () => ({ decodeAudioRange: vi.fn() }));
vi.mock('../media/imagen', () => ({ cargarImagen: vi.fn() }));

const { probeClip } = await import('../media/probe');
const { decodeAudioRange } = await import('../audio/decode');
const { cargarImagen } = await import('../media/imagen');

const INFO: ClipInfo = {
  name: 'C0021.MP4',
  sizeBytes: 10,
  codec: 'avc',
  codecString: 'avc1.640028',
  displayWidth: 1920,
  displayHeight: 1080,
  rotation: 0,
  frameRate: 25,
  frameRateIsConstant: true,
  durationSeconds: 20,
  colorSpace: {},
  isHdr: false,
  canDecode: true,
  hasAudio: true,
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: 2,
  audioCanDecode: true,
};

function archivo(nombre: string): File {
  return new File(['xxxxx'], nombre, { lastModified: 1 });
}

function clipDoc(id: string, nombre: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    huella: { nombre, tamano: 5, fecha: 1 },
    lutConvId: null,
    lutLookId: null,
    fit: 'cover' as const,
    panX: 0,
    panY: 0,
    speed: 1,
    trimIn: 0,
    trimOut: 20,
    volume: 1,
    ...extra,
  };
}

function doc(extra: Partial<ProyectoDoc> = {}): ProyectoDoc {
  return {
    version: 1,
    id: 'p1',
    nombre: 'viaje',
    actualizado: 0,
    presetId: DEFAULT_PRESET.id,
    selectedId: 'c1',
    clips: [clipDoc('c1', 'C0021.MP4')],
    luts: [],
    music: null,
    capa: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(probeClip).mockReset().mockResolvedValue(INFO);
  vi.mocked(decodeAudioRange).mockReset();
  vi.mocked(cargarImagen).mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:falso');
});

describe('reconstruir', () => {
  it('rearma el clip con sus ajustes y le recalcula el diagnostico del archivo', async () => {
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'C0021.MP4', { trimIn: 3, trimOut: 12, speed: 0.5, panX: 0.4 })] }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );

    expect(estado.clips).toHaveLength(1);
    expect(estado.clips[0]).toMatchObject({ trimIn: 3, trimOut: 12, speed: 0.5, panX: 0.4 });
    expect(estado.clips[0]?.info).toBe(INFO);
    expect(estado.avisos).toEqual([]);
  });

  it('el clip cuyo archivo no vino queda afuera, y el resto del montaje entra igual', async () => {
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'A.MP4'), clipDoc('c2', 'B.MP4')] }),
      new Map([['c2', archivo('B.MP4')]]),
      [],
    );

    expect(estado.clips.map((c) => c.id)).toEqual(['c2']);
    expect(estado.avisos[0]).toContain('A.MP4');
    // La seleccion guardada murio con el clip: cae en el que quedo.
    expect(estado.selectedId).toBe('c2');
  });

  it('un archivo mas corto que el recorte guardado acorta el recorte y avisa', async () => {
    vi.mocked(probeClip).mockResolvedValue({ ...INFO, durationSeconds: 7 });
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'C0021.MP4', { trimIn: 3, trimOut: 20 })] }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );

    expect(estado.clips[0]?.trimOut).toBe(7);
    expect(estado.avisos.join(' ')).toContain('no entraba');
  });

  it('un clip que no se puede abrir no se lleva puesto el montaje', async () => {
    vi.mocked(probeClip)
      .mockRejectedValueOnce(new Error('codec raro'))
      .mockResolvedValueOnce(INFO);
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'A.MP4'), clipDoc('c2', 'B.MP4')] }),
      new Map([
        ['c1', archivo('A.MP4')],
        ['c2', archivo('B.MP4')],
      ]),
      [],
    );

    expect(estado.clips.map((c) => c.id)).toEqual(['c2']);
    expect(estado.avisos.join(' ')).toContain('codec raro');
  });

  it('mantiene el LUT que sigue en la biblioteca', async () => {
    const biblioteca: LibraryLut[] = [
      { id: 'lutA', name: 'slog3.cube', lut: { size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: new Float32Array(24) } },
    ];
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'A.MP4', { lutConvId: 'lutA' })], luts: ['lutA'] }),
      new Map([['c1', archivo('A.MP4')]]),
      biblioteca,
    );

    expect(estado.clips[0]?.lutConvId).toBe('lutA');
    expect(estado.avisos).toEqual([]);
  });

  it('el clip cuyo LUT ya no esta entra sin LUT, no sin clip', async () => {
    const estado = await reconstruir(
      doc({ clips: [clipDoc('c1', 'A.MP4', { lutConvId: 'borrado' })], luts: ['borrado'] }),
      new Map([['c1', archivo('A.MP4')]]),
      [],
    );

    expect(estado.clips).toHaveLength(1);
    expect(estado.clips[0]?.lutConvId).toBeNull();
    expect(estado.avisos.join(' ')).toContain('biblioteca');
  });

  it('la musica sacada de un clip se rearma con el archivo de ese clip', async () => {
    vi.mocked(decodeAudioRange).mockResolvedValue({ duration: 60 } as AudioBuffer);
    const estado = await reconstruir(
      doc({
        music: {
          id: 'm1',
          name: 'C0021.MP4',
          origen: 'clip',
          clipId: 'c1',
          huella: { nombre: 'C0021.MP4', tamano: 5, fecha: 1 },
          startInMusic: 2,
          endInMusic: 40,
          volume: 0.5,
          fadeIn: 0,
          fadeOut: 1.5,
        },
      }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );

    expect(estado.music?.origen).toBe('clip');
    expect(estado.music?.endInMusic).toBe(40);
    expect(vi.mocked(decodeAudioRange).mock.calls[0]?.[0].name).toBe('C0021.MP4');
  });

  it('acota las marcas de la musica a la duracion del tema elegido', async () => {
    vi.mocked(decodeAudioRange).mockResolvedValue({ duration: 30 } as AudioBuffer);
    const estado = await reconstruir(
      doc({
        music: {
          id: 'm1',
          name: 'tema.mp3',
          origen: 'archivo',
          clipId: null,
          huella: { nombre: 'tema.mp3', tamano: 5, fecha: 1 },
          startInMusic: 0,
          endInMusic: 200,
          volume: 0.8,
          fadeIn: 0,
          fadeOut: 1.5,
        },
      }),
      new Map([
        ['c1', archivo('C0021.MP4')],
        [SLOT_MUSICA, archivo('tema.mp3')],
      ]),
      [],
    );

    expect(estado.music?.endInMusic).toBe(30);
  });

  it('sin el archivo de la capa el montaje entra sin capa y avisa', async () => {
    const estado = await reconstruir(
      doc({
        capa: {
          id: 'capa1',
          name: 'logo.png',
          huella: { nombre: 'logo.png', tamano: 5, fecha: 1 },
          startSeconds: 0,
          endSeconds: 10,
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          opacity: 1,
          entradaSeconds: 0,
          salidaSeconds: 0,
          scaleEntrada: 0.85,
          scaleSalida: 0.85,
        },
      }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );

    expect(estado.clips).toHaveLength(1);
    expect(estado.capa).toBeNull();
    expect(estado.avisos.join(' ')).toContain('logo.png');
    expect(vi.mocked(cargarImagen)).not.toHaveBeenCalled();
  });

  it('recupera la salida elegida, y cae en la de siempre si ya no existe', async () => {
    const otra = EXPORT_PRESETS.find((p) => p.id !== DEFAULT_PRESET.id);
    const conservada = await reconstruir(
      doc({ presetId: otra?.id ?? DEFAULT_PRESET.id }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );
    expect(conservada.preset.id).toBe(otra?.id);

    const perdida = await reconstruir(
      doc({ presetId: 'formato-que-ya-no-existe' }),
      new Map([['c1', archivo('C0021.MP4')]]),
      [],
    );
    expect(perdida.preset).toBe(DEFAULT_PRESET);
    expect(perdida.avisos.join(' ')).toContain('salida');
  });

  it('con la imagen elegida, la capa vuelve con sus tiempos y su animacion', async () => {
    vi.mocked(cargarImagen).mockResolvedValue({
      bitmap: {} as ImageBitmap,
      width: 500,
      height: 200,
    });
    const estado = await reconstruir(
      doc({
        capa: {
          id: 'capa1',
          name: 'logo.png',
          huella: { nombre: 'logo.png', tamano: 5, fecha: 1 },
          startSeconds: 2,
          endSeconds: 9,
          scale: 0.4,
          offsetX: -0.6,
          offsetY: 0.3,
          opacity: 0.8,
          entradaSeconds: 0.5,
          salidaSeconds: 1,
          scaleEntrada: 0.85,
          scaleSalida: 1,
        },
      }),
      new Map([
        ['c1', archivo('C0021.MP4')],
        [SLOT_CAPA, archivo('logo.png')],
      ]),
      [],
    );

    expect(estado.capa).toMatchObject({
      startSeconds: 2,
      endSeconds: 9,
      scale: 0.4,
      offsetX: -0.6,
      opacity: 0.8,
      entradaSeconds: 0.5,
      width: 500,
      height: 200,
    });
    expect(estado.avisos).toEqual([]);
  });

  it('un proyecto vacio se reconstruye sin pedir nada', async () => {
    const estado = await reconstruir(doc({ clips: [], selectedId: null }), new Map(), []);
    expect(estado.clips).toEqual([]);
    expect(estado.selectedId).toBeNull();
    expect(estado.avisos).toEqual([]);
    expect(vi.mocked(probeClip)).not.toHaveBeenCalled();
  });
});
