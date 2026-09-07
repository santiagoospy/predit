/**
 * Los parsers contra bytes armados a mano.
 *
 * No reemplazan la prueba con un clip de verdad -si Sony cambia un tag, esto
 * sigue en verde y el archivo no se lee- pero fijan lo que si se puede fijar:
 * que la escala se aplique, que los tiempos se repartan dentro del cuadro, y
 * que un archivo raro devuelva vacio en vez de romper.
 */

import { describe, expect, it } from 'vitest';

import { leerGoPro } from './gopro';
import { leerSony } from './sony';

/** Arma una muestra RTMD de Sony con los tags que importan. */
function muestraSony(
  ternas: [number, number, number][],
  { escala = 100, frecuencia = 8, radianes = false } = {},
): ArrayBuffer {
  const cuerpo: number[] = [];
  const u16 = (v: number) => cuerpo.push((v >> 8) & 0xff, v & 0xff);
  const i32 = (v: number) => cuerpo.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const f32 = (v: number) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    for (let i = 0; i < 4; i++) cuerpo.push(b.getUint8(i));
  };

  // Frecuencia
  u16(0xe435);
  u16(4);
  i32(frecuencia);
  // Unidad de la escala
  u16(0xe438);
  u16(1);
  cuerpo.push(radianes ? 1 : 0);
  // Escala
  u16(0xe439);
  u16(4);
  f32(escala);
  // Datos
  u16(0xe43b);
  u16(8 + ternas.length * 6);
  i32(ternas.length);
  i32(6);
  for (const [x, y, z] of ternas) {
    u16(x & 0xffff);
    u16(y & 0xffff);
    u16(z & 0xffff);
  }

  // 0x1C de cabecera, con el 0x001C que marca que es RTMD.
  const bytes = new Uint8Array(0x1c + cuerpo.length);
  bytes[0] = 0x00;
  bytes[1] = 0x1c;
  bytes.set(cuerpo, 0x1c);
  return bytes.buffer;
}

/** Arma un nodo GPMF: clave, tipo, tamano, cantidad y contenido con relleno. */
function nodo(clave: string, tipo: string, porElemento: number, cuantos: number, datos: number[]) {
  const relleno = (4 - (datos.length % 4)) % 4;
  return [
    ...[...clave].map((c) => c.charCodeAt(0)),
    tipo.charCodeAt(0),
    porElemento,
    (cuantos >> 8) & 0xff,
    cuantos & 0xff,
    ...datos,
    ...new Array<number>(relleno).fill(0),
  ];
}

/** Arma una muestra GPMF con un DEVC que contiene un STRM con SCAL y GYRO. */
function muestraGoPro(ternas: [number, number, number][], escala = 10): ArrayBuffer {
  const gyroBytes: number[] = [];
  for (const terna of ternas) {
    for (const v of terna) gyroBytes.push((v >> 8) & 0xff, v & 0xff);
  }
  const gyro = nodo('GYRO', 's', 6, ternas.length, gyroBytes);
  const scal = nodo('SCAL', 's', 2, 1, [(escala >> 8) & 0xff, escala & 0xff]);
  const strm = nodo('STRM', '\0', 1, scal.length + gyro.length, [...scal, ...gyro]);
  const devc = nodo('DEVC', '\0', 1, strm.length, strm);
  return new Uint8Array(devc).buffer;
}

describe('leerSony', () => {
  it('aplica la escala y reparte los tiempos con la frecuencia', () => {
    const { muestras } = leerSony([
      { bytes: muestraSony([[100, 200, 300], [400, 500, 600]], { escala: 100, frecuencia: 8 }), segundo: 1 },
    ]);
    expect(muestras).toHaveLength(2);
    // 100 unidades / escala 100 = 1 grado por segundo.
    expect(muestras[0]!.x).toBeCloseTo(1);
    expect(muestras[0]!.y).toBeCloseTo(2);
    expect(muestras[0]!.z).toBeCloseTo(3);
    expect(muestras[0]!.segundo).toBeCloseTo(1);
    // La segunda medicion cae un 1/8 de segundo despues.
    expect(muestras[1]!.segundo).toBeCloseTo(1.125);
    expect(muestras[1]!.x).toBeCloseTo(4);
  });

  it('pasa a grados cuando la camara declara radianes', () => {
    const { muestras } = leerSony([
      { bytes: muestraSony([[100, 0, 0]], { escala: 100, radianes: true }), segundo: 0 },
    ]);
    expect(muestras[0]!.x).toBeCloseTo(180 / Math.PI);
  });

  it('lee valores negativos', () => {
    const { muestras } = leerSony([{ bytes: muestraSony([[-100, 0, 0]], { escala: 100 }), segundo: 0 }]);
    expect(muestras[0]!.x).toBeCloseTo(-1);
  });

  it('arrastra la escala a las muestras que no la repiten', () => {
    const conEscala = muestraSony([[100, 0, 0]], { escala: 100 });
    // Una muestra sin el tag de escala: se arma a mano solo con los datos.
    const cuerpo = [0xe4, 0x3b, 0x00, 0x0e, 0, 0, 0, 1, 0, 0, 0, 6, 0, 200, 0, 0, 0, 0];
    const sinEscala = new Uint8Array(0x1c + cuerpo.length);
    sinEscala[1] = 0x1c;
    sinEscala.set(cuerpo, 0x1c);

    const { muestras } = leerSony([
      { bytes: conEscala, segundo: 0 },
      { bytes: sinEscala.buffer, segundo: 1 },
    ]);
    expect(muestras[1]!.x).toBeCloseTo(2);
  });

  it('ignora una muestra que no es RTMD en vez de romper', () => {
    expect(leerSony([{ bytes: new Uint8Array([1, 2, 3, 4]).buffer, segundo: 0 }]).muestras).toEqual([]);
  });
});

describe('leerGoPro', () => {
  it('divide por el SCAL y reparte los tiempos en el tramo de la muestra', () => {
    const muestras = leerGoPro([
      { bytes: muestraGoPro([[100, 200, 300], [400, 500, 600]], 10), segundo: 0 },
      { bytes: muestraGoPro([[0, 0, 0]], 10), segundo: 1 },
    ]);
    expect(muestras[0]!.x).toBeCloseTo(10);
    expect(muestras[0]!.y).toBeCloseTo(20);
    expect(muestras[0]!.segundo).toBeCloseTo(0);
    // La muestra dura 1s y trae dos mediciones: la segunda cae a la mitad.
    expect(muestras[1]!.segundo).toBeCloseTo(0.5);
  });

  it('ignora bytes que no son GPMF en vez de romper', () => {
    expect(leerGoPro([{ bytes: new Uint8Array([9, 9, 9, 9]).buffer, segundo: 0 }])).toEqual([]);
  });

  it('devuelve vacio si el stream no tiene GYRO', () => {
    const scal = nodo('SCAL', 's', 2, 1, [0, 10]);
    const strm = nodo('STRM', '\0', 1, scal.length, scal);
    const devc = nodo('DEVC', '\0', 1, strm.length, strm);
    expect(leerGoPro([{ bytes: new Uint8Array(devc).buffer, segundo: 0 }])).toEqual([]);
  });
});

describe('optica de Sony', () => {
  /** Una muestra con los tags de la camara, y opcionalmente el del lente. */
  function conOptica({ focalNm }: { focalNm: number | null }): ArrayBuffer {
    const cuerpo: number[] = [];
    const u16 = (v: number) => cuerpo.push((v >> 8) & 0xff, v & 0xff);
    const i32 = (v: number) =>
      cuerpo.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

    // Tamano del pixel: 3800 nm de ancho.
    u16(0xe407);
    u16(4);
    u16(3800);
    u16(3800);
    // Recorte del sensor: 6192 pixeles de ancho (unidad 1).
    u16(0xe408);
    u16(4);
    i32(1);
    u16(0xe40a);
    u16(8);
    i32(6192);
    i32(3484);
    if (focalNm !== null) {
      u16(0xe410);
      u16(12);
      i32(0);
      i32(0);
      i32(focalNm);
    }
    // Un dato de giroscopio para que la muestra cuente.
    u16(0xe439);
    u16(4);
    cuerpo.push(0x42, 0xc8, 0x00, 0x00); // escala 100.0
    u16(0xe43b);
    u16(14);
    i32(1);
    i32(6);
    u16(100);
    u16(0);
    u16(0);

    const bytes = new Uint8Array(0x1c + cuerpo.length);
    bytes[1] = 0x1c;
    bytes.set(cuerpo, 0x1c);
    return bytes.buffer;
  }

  it('calcula el ancho del sensor con lo que escribe la camara', () => {
    const { optica } = leerSony([{ bytes: conOptica({ focalNm: 35e6 }), segundo: 0 }], 3840);
    // 3800 nm por pixel x 6192 pixeles = 23.5 mm: un Super35 / aps-c.
    expect(optica?.sensorAnchoMm).toBeCloseTo(23.5, 1);
  });

  it('convierte los mm del lente a pixeles de la imagen', () => {
    const { optica } = leerSony([{ bytes: conOptica({ focalNm: 35e6 }), segundo: 0 }], 3840);
    expect(optica?.focalMm).toBeCloseTo(35, 3);
    // 35mm sobre el ancho exacto del sensor (3800nm x 6192px), por 3840
    // pixeles de imagen. Se calcula del valor leido y no de uno redondeado:
    // la cuenta tiene que cerrar exacta.
    const sensor = (3800 * 6192) / 1e6;
    expect(optica?.focalPx).toBeCloseTo((35 / sensor) * 3840, 4);
  });

  it('con un lente manual da el sensor pero no la focal', () => {
    const { optica } = leerSony([{ bytes: conOptica({ focalNm: null }), segundo: 0 }], 3840);
    expect(optica?.sensorAnchoMm).toBeCloseTo(23.5, 1);
    expect(optica?.focalMm).toBeNull();
    expect(optica?.focalPx).toBeNull();
  });

  it('sin el ancho del video no calcula nada', () => {
    const { optica } = leerSony([{ bytes: conOptica({ focalNm: 35e6 }), segundo: 0 }]);
    expect(optica).toBeNull();
  });
});
