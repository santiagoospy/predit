import { describe, expect, it } from 'vitest';

import type { MusicTrack, OverlayLayer, TimelineClip } from '../edit/types';
import { EXPORT_PRESETS } from '../export/presets';
import type { ClipInfo } from '../media/probe';
import {
  emparejar,
  faltantes,
  haceCuanto,
  huellaDe,
  mismoContenido,
  resumir,
  serializarProyecto,
  SLOT_CAPA,
  SLOT_MUSICA,
  type EstadoProyecto,
} from './esquema';

function archivo(nombre: string, tamano: number, fecha: number): File {
  return new File(['x'.repeat(tamano)], nombre, { lastModified: fecha });
}

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

function clip(id: string, file: File, extra: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id,
    file,
    url: `blob:${id}`,
    info: { ...INFO, name: file.name, sizeBytes: file.size },
    warnings: [],
    lutConvId: null,
    lutLookId: null,
    lift: 0,
    gamma: 1,
    gain: 1,
    fit: 'cover',
    panX: 0,
    panY: 0,
    speed: 1,
    trimIn: 0,
    trimOut: 20,
    volume: 1,
    ...extra,
  };
}

function estado(clips: TimelineClip[], extra: Partial<EstadoProyecto> = {}): EstadoProyecto {
  return {
    id: 'p1',
    nombre: 'viaje',
    clips,
    music: null,
    capa: null,
    preset: EXPORT_PRESETS[0]!,
    selectedId: clips[0]?.id ?? null,
    ...extra,
  };
}

describe('serializarProyecto', () => {
  it('guarda los ajustes del clip y su huella, pero no el archivo', () => {
    const file = archivo('C0021.MP4', 120, 1700000000000);
    const doc = serializarProyecto(
      estado([clip('clip1', file, { trimIn: 2, trimOut: 8, speed: 0.5, panX: 0.3, lift: 0.1, gain: 1.2 })]),
      555,
    );

    const guardado = doc.clips[0]!;
    expect(guardado).toEqual({
      id: 'clip1',
      huella: { nombre: 'C0021.MP4', tamano: 120, fecha: 1700000000000 },
      lutConvId: null,
      lutLookId: null,
      lift: 0.1,
      gamma: 1,
      gain: 1.2,
      fit: 'cover',
      panX: 0.3,
      panY: 0,
      speed: 0.5,
      trimIn: 2,
      trimOut: 8,
      volume: 1,
    });
    expect(doc.actualizado).toBe(555);
    // Lo que no se puede serializar no tiene que haberse colado.
    expect(JSON.stringify(doc)).not.toContain('blob:');
  });

  it('junta los LUTs que el montaje usa, sin repetirlos', () => {
    const a = clip('c1', archivo('a.mp4', 10, 1), { lutConvId: 'lutA', lutLookId: 'lutB' });
    const b = clip('c2', archivo('b.mp4', 10, 1), { lutConvId: 'lutA', lutLookId: null });
    expect(serializarProyecto(estado([a, b])).luts.sort()).toEqual(['lutA', 'lutB']);
  });

  it('el documento entero sobrevive a un ida y vuelta por JSON', () => {
    const doc = serializarProyecto(estado([clip('c1', archivo('a.mp4', 10, 1))]));
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

describe('mismoContenido', () => {
  it('no mira la fecha de guardado: dos guardados seguidos sin tocar nada son iguales', () => {
    const clips = [clip('c1', archivo('a.mp4', 10, 1))];
    expect(mismoContenido(serializarProyecto(estado(clips), 1), serializarProyecto(estado(clips), 9))).toBe(
      true,
    );
  });

  it('un recorte distinto ya es otro contenido', () => {
    const antes = serializarProyecto(estado([clip('c1', archivo('a.mp4', 10, 1))]), 1);
    const despues = serializarProyecto(
      estado([clip('c1', archivo('a.mp4', 10, 1), { trimIn: 3 })]),
      1,
    );
    expect(mismoContenido(antes, despues)).toBe(false);
  });
});

describe('faltantes', () => {
  const musica = (extra: Partial<MusicTrack>): MusicTrack => ({
    id: 'm1',
    name: 'tema.mp3',
    origen: 'archivo',
    huella: { nombre: 'tema.mp3', tamano: 4000, fecha: 7 },
    clipId: null,
    buffer: null as unknown as AudioBuffer,
    duracionSeconds: 120,
    startInMusic: 0,
    endInMusic: 120,
    volume: 0.8,
    fadeIn: 0,
    fadeOut: 1.5,
    ...extra,
  });

  it('pide un archivo por clip', () => {
    const doc = serializarProyecto(
      estado([clip('c1', archivo('a.mp4', 10, 1)), clip('c2', archivo('b.mp4', 20, 2))]),
    );
    expect(faltantes(doc).map((f) => f.slot)).toEqual(['c1', 'c2']);
  });

  it('pide la musica cuando salio de un archivo suelto', () => {
    const doc = serializarProyecto(
      estado([clip('c1', archivo('a.mp4', 10, 1))], { music: musica({}) }),
    );
    const pedido = faltantes(doc).find((f) => f.slot === SLOT_MUSICA);
    expect(pedido?.huella.nombre).toBe('tema.mp3');
  });

  it('NO pide la musica sacada de un clip: su archivo es el del clip', () => {
    const doc = serializarProyecto(
      estado([clip('c1', archivo('a.mp4', 10, 1))], {
        music: musica({ origen: 'clip', clipId: 'c1', huella: huellaDe(archivo('a.mp4', 10, 1)) }),
      }),
    );
    expect(faltantes(doc).map((f) => f.slot)).toEqual(['c1']);
  });

  it('si el clip del que salio la musica ya no esta, vuelve a pedir el archivo', () => {
    const doc = serializarProyecto(
      estado([clip('c1', archivo('a.mp4', 10, 1))], {
        music: musica({ origen: 'clip', clipId: 'borrado' }),
      }),
    );
    expect(faltantes(doc).map((f) => f.slot)).toEqual(['c1', SLOT_MUSICA]);
  });

  it('pide la imagen de la capa', () => {
    const capa: OverlayLayer = {
      id: 'capa1',
      name: 'logo.png',
      huella: { nombre: 'logo.png', tamano: 900, fecha: 3 },
      bitmap: null as unknown as ImageBitmap,
      width: 500,
      height: 500,
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
    };
    const doc = serializarProyecto(estado([clip('c1', archivo('a.mp4', 10, 1))], { capa }));
    expect(faltantes(doc).map((f) => f.slot)).toEqual(['c1', SLOT_CAPA]);
  });
});

describe('emparejar', () => {
  const pendientes = faltantes(
    serializarProyecto(
      estado([
        clip('c1', archivo('C0021.MP4', 120, 1000)),
        clip('c2', archivo('GX010045.MP4', 340, 2000)),
      ]),
    ),
  );

  it('reconoce el archivo exacto', () => {
    const elegido = archivo('C0021.MP4', 120, 1000);
    const { asignados, sobrantes } = emparejar(pendientes, [elegido]);
    expect(asignados.get('c1')).toBe(elegido);
    expect(asignados.has('c2')).toBe(false);
    expect(sobrantes).toEqual([]);
  });

  it('lo reconoce igual si perdio la fecha al pasar por el carrete', () => {
    const elegido = archivo('C0021.MP4', 120, 999999);
    expect(emparejar(pendientes, [elegido]).asignados.get('c1')).toBe(elegido);
  });

  it('en ultima instancia se queda con el nombre, aunque el tamano no de', () => {
    const elegido = archivo('C0021.MP4', 55, 999999);
    expect(emparejar(pendientes, [elegido]).asignados.get('c1')).toBe(elegido);
  });

  it('no le importan las mayusculas del nombre', () => {
    const elegido = archivo('c0021.mp4', 120, 1000);
    expect(emparejar(pendientes, [elegido]).asignados.get('c1')).toBe(elegido);
  });

  it('prefiere el archivo exacto antes que el que solo coincide de nombre', () => {
    const exacto = archivo('C0021.MP4', 120, 1000);
    const parecido = archivo('C0021.MP4', 77, 4444);
    expect(emparejar(pendientes, [parecido, exacto]).asignados.get('c1')).toBe(exacto);
  });

  it('un mismo archivo no llena dos lugares: el segundo queda pendiente', () => {
    const dosCortes = faltantes(
      serializarProyecto(
        estado([
          clip('c1', archivo('C0021.MP4', 120, 1000)),
          clip('c2', archivo('C0021.MP4', 120, 1000)),
        ]),
      ),
    );
    const uno = archivo('C0021.MP4', 120, 1000);
    const { asignados } = emparejar(dosCortes, [uno]);
    expect(asignados.get('c1')).toBe(uno);
    expect(asignados.has('c2')).toBe(false);
  });

  it('devuelve lo que el usuario eligio de mas', () => {
    const ajeno = archivo('otra-cosa.mp4', 10, 1);
    const { sobrantes } = emparejar(pendientes, [archivo('C0021.MP4', 120, 1000), ajeno]);
    expect(sobrantes).toEqual([ajeno]);
  });
});

describe('resumir', () => {
  it('cuenta los clips y suma la duracion ya con la velocidad aplicada', () => {
    const doc = serializarProyecto(
      estado([
        clip('c1', archivo('a.mp4', 10, 1), { trimIn: 0, trimOut: 10, speed: 1 }),
        clip('c2', archivo('b.mp4', 10, 1), { trimIn: 0, trimOut: 10, speed: 2 }),
      ]),
    );
    const resumen = resumir(doc);
    expect(resumen.clips).toBe(2);
    expect(resumen.duracionSeconds).toBeCloseTo(15, 6);
  });
});

describe('haceCuanto', () => {
  const ahora = 1_700_000_000_000;

  it('lo recien guardado no dice un numero', () => {
    expect(haceCuanto(ahora - 5_000, ahora)).toBe('recién');
  });

  it('pasa a minutos, horas y dias', () => {
    expect(haceCuanto(ahora - 4 * 60_000, ahora)).toBe('hace 4 minutos');
    expect(haceCuanto(ahora - 60_000, ahora)).toBe('hace 1 minuto');
    expect(haceCuanto(ahora - 3 * 3_600_000, ahora)).toBe('hace 3 horas');
    expect(haceCuanto(ahora - 2 * 86_400_000, ahora)).toBe('hace 2 días');
  });
});
