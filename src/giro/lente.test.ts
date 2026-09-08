/**
 * El modelo de ojo de pez, contra numeros que se pueden calcular a mano y
 * contra el perfil real de Gyroflow.
 */

import { describe, expect, it } from 'vitest';

import { estabilizacionFija, prepararEstabilizacion, MAPEO_GOPRO } from './estabilizar';
import {
  desproyectarLente,
  escalarPerfil,
  perfilDesdeGyroflow,
  perfilPara,
  proyectarLente,
  PERFIL_GOPRO_WIDE_8_7,
  type PerfilLente,
} from './lente';
import type { MuestraGiro } from './tipos';

/** Un ojo de pez equidistante perfecto: sin coeficientes, pixel = f * theta. */
const EQUIDISTANTE: PerfilLente = {
  nombre: 'equidistante',
  fx: 1000,
  fy: 1000,
  cx: 960,
  cy: 540,
  k: [0, 0, 0, 0],
  ancho: 1920,
  alto: 1080,
};

describe('proyectarLente', () => {
  it('el rayo del eje cae en el centro optico', () => {
    expect(proyectarLente(EQUIDISTANTE, 0, 0, 1)).toEqual([960, 540]);
  });

  it('sin coeficientes es f por el angulo', () => {
    // 45 grados a la derecha: pi/4 radianes por 1000 px.
    const [x, y] = proyectarLente(EQUIDISTANTE, 1, 0, 1);
    expect(x).toBeCloseTo(960 + (Math.PI / 4) * 1000, 6);
    expect(y).toBeCloseTo(540, 6);
  });

  it('cerca del eje coincide con el agujero de alfiler', () => {
    const [x] = proyectarLente(EQUIDISTANTE, 0.01, 0, 1);
    expect(x).toBeCloseTo(960 + 10, 2);
  });

  it('un rayo hacia atras queda afuera de la imagen', () => {
    const [x, y] = proyectarLente(EQUIDISTANTE, 0, 0, -1);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
  });

  it('el perfil real comprime los bordes respecto del agujero de alfiler', () => {
    const p = PERFIL_GOPRO_WIDE_8_7;
    // A 50 grados del eje: el agujero de alfiler daria f*tan(50°) = 2031 px del
    // centro; el ojo de pez tiene que dar bastante menos.
    const [x] = proyectarLente(p, Math.tan((50 * Math.PI) / 180), 0, 1);
    expect(x - p.cx).toBeLessThan(1700);
    expect(x - p.cx).toBeGreaterThan(1400);
  });
});

describe('desproyectarLente', () => {
  it('deshace a proyectarLente en todo el cuadro del perfil real', () => {
    const p = PERFIL_GOPRO_WIDE_8_7;
    for (const [px, py] of [
      [p.cx, p.cy],
      [100, 100],
      [3800, 3300],
      [50, 1700],
      [1900, 40],
    ]) {
      const [x, y, z] = desproyectarLente(p, px!, py!);
      const [qx, qy] = proyectarLente(p, x, y, z);
      expect(qx).toBeCloseTo(px!, 3);
      expect(qy).toBeCloseTo(py!, 3);
    }
  });

  it('el centro optico da el rayo del eje', () => {
    expect(desproyectarLente(EQUIDISTANTE, 960, 540)).toEqual([0, 0, 1]);
  });
});

describe('perfilDesdeGyroflow', () => {
  const archivo = {
    calibration_data: {
      name: 'GoPro_HERO11 Black_Wide_8by7',
      calib_dimension: { w: 3840, h: 3360 },
      fisheye_params: {
        camera_matrix: [
          [1703.94, 0, 1935.07],
          [0, 1703.24, 1676.83],
          [0, 0, 1],
        ],
        distortion_coeffs: [0.0314, 0.0597, -0.0434, 0.0099],
      },
    },
  };

  it('lee focal, centro, coeficientes y dimension de un .gyroflow', () => {
    const p = perfilDesdeGyroflow(archivo)!;
    expect(p.nombre).toBe('GoPro_HERO11 Black_Wide_8by7');
    expect(p.fx).toBeCloseTo(1703.94);
    expect(p.fy).toBeCloseTo(1703.24);
    expect(p.cx).toBeCloseTo(1935.07);
    expect(p.cy).toBeCloseTo(1676.83);
    expect(p.k).toEqual([0.0314, 0.0597, -0.0434, 0.0099]);
    expect(p.ancho).toBe(3840);
    expect(p.alto).toBe(3360);
  });

  it('acepta el perfil suelto, sin la raiz calibration_data', () => {
    expect(perfilDesdeGyroflow(archivo.calibration_data)?.fx).toBeCloseTo(1703.94);
  });

  it('rechaza lo que no es un perfil', () => {
    expect(perfilDesdeGyroflow(null)).toBeNull();
    expect(perfilDesdeGyroflow({})).toBeNull();
    expect(perfilDesdeGyroflow({ calibration_data: { fisheye_params: {} } })).toBeNull();
  });
});

describe('escalarPerfil', () => {
  it('a mitad de resolucion, la focal y el centro se achican a la mitad y los k no', () => {
    const p = escalarPerfil(PERFIL_GOPRO_WIDE_8_7, 1920, 1680)!;
    expect(p.fx).toBeCloseTo(PERFIL_GOPRO_WIDE_8_7.fx / 2);
    expect(p.cx).toBeCloseTo(PERFIL_GOPRO_WIDE_8_7.cx / 2);
    expect(p.k).toEqual(PERFIL_GOPRO_WIDE_8_7.k);
  });

  it('se niega a escalar a otro aspecto: es otro modo de la camara', () => {
    expect(escalarPerfil(PERFIL_GOPRO_WIDE_8_7, 3840, 2160)).toBeNull();
  });

  it('perfilPara solo conoce el 8:7 de GoPro', () => {
    expect(perfilPara('gopro', 3840, 3360)?.nombre).toBe(PERFIL_GOPRO_WIDE_8_7.nombre);
    expect(perfilPara('gopro', 3840, 2160)).toBeNull();
    expect(perfilPara('sony', 3840, 3360)).toBeNull();
  });
});

describe('el muestreo con lente', () => {
  const lente = PERFIL_GOPRO_WIDE_8_7;
  const base = { focalPx: lente.fx, ancho: 3840, alto: 3360, lente };
  const quieta = { pitch: 0, yaw: 0, roll: 0 };

  it('sin correccion, el centro de la salida cae en el centro optico', () => {
    const punto = estabilizacionFija(quieta, base).puntoEn(0);
    const [x, y] = punto(1920, 1680);
    expect(x).toBeCloseTo(lente.cx, 6);
    expect(y).toBeCloseTo(lente.cy, 6);
  });

  it('rectificando, el borde de la salida cae bien adentro de la entrada', () => {
    // Una imagen rectilinea de la misma focal abarca menos campo que el ojo de
    // pez: la esquina de la salida tiene que quedar lejos de la esquina de la
    // entrada.
    const punto = estabilizacionFija(quieta, { ...base, rectificar: true }).puntoEn(0);
    const [x, y] = punto(0, 0);
    expect(x).toBeGreaterThan(400);
    expect(y).toBeGreaterThan(400);
  });

  it('sin rectificar y sin correccion, cada pixel se muestrea a si mismo', () => {
    const punto = estabilizacionFija(quieta, { ...base, rectificar: false }).puntoEn(0);
    for (const [px, py] of [[0, 0], [3840, 3360], [100, 3000], [1920, 1680]]) {
      const [x, y] = punto(px!, py!);
      expect(x).toBeCloseTo(px!, 3);
      expect(y).toBeCloseTo(py!, 3);
    }
  });

  it('un yaw fijo corre el centro lo mismo que el agujero de alfiler, y el borde menos', () => {
    const conLente = estabilizacionFija({ pitch: 0, yaw: 1, roll: 0 }, { ...base, rectificar: false });
    const sinLente = estabilizacionFija(
      { pitch: 0, yaw: 1, roll: 0 },
      { focalPx: lente.fx, ancho: 3840, alto: 3360 },
    );
    const centroLente = conLente.puntoEn(0)(1920, 1680)[0] - 1920;
    const centroPinhole = sinLente.puntoEn(0)(1920, 1680)[0] - 1920;
    expect(centroLente).toBeCloseTo(centroPinhole, 0);
    expect(Math.abs(centroLente)).toBeGreaterThan(25);

    const bordeLente = conLente.puntoEn(0)(3700, 1680)[0] - 3700;
    const bordePinhole = sinLente.puntoEn(0)(3700, 1680)[0] - 3700;
    expect(Math.sign(bordeLente)).toBe(Math.sign(bordePinhole));
    expect(Math.abs(bordeLente)).toBeLessThan(Math.abs(bordePinhole) * 0.8);
  });

  it('muestreoEn entrega las piezas del shader', () => {
    const m = estabilizacionFija(quieta, base).muestreoEn(0);
    expect(m.tipo).toBe('lente');
    if (m.tipo !== 'lente') return;
    expect(m.lente).toBe(lente);
    expect(m.focalSalida).toBeCloseTo(lente.fx);
    expect(m.rotacion).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(m.ancho).toBe(3840);
  });

  it('sin lente, muestreoEn sigue siendo la homografia en UV', () => {
    const m = estabilizacionFija(quieta, { focalPx: 1500, ancho: 1920, alto: 1080 }).muestreoEn(0);
    expect(m.tipo).toBe('matriz');
  });

  it('con un temblor, el zoom deja todo el borde adentro de la entrada', () => {
    const muestras: MuestraGiro[] = [];
    for (let i = 0; i <= 600; i++) {
      const t = i / 300;
      muestras.push({ segundo: t, x: 40 * Math.sin(t * 34), y: 30 * Math.sin(t * 27 + 1), z: 10 * Math.sin(t * 20) });
    }
    // En los instantes en que se muestreo el zoom (cada 0.04 s): entre dos
    // muestras la correccion puede pasarse un par de pixeles, con o sin lente.
    const cuadros = Array.from({ length: 36 }, (_, i) => 0.3 + i * 0.04);
    for (const rectificar of [true, false]) {
      const e = prepararEstabilizacion(muestras, cuadros, {
        suavidad: 1,
        desfase: 0,
        mapeo: MAPEO_GOPRO,
        zoomMaximo: 4,
        ...base,
        rectificar,
      });
      expect(e.correccionMaxGrados).toBeGreaterThan(1);
      for (const t of cuadros) {
        const punto = e.puntoEn(t);
        for (let i = 0; i <= 20; i++) {
          const s = i / 20;
          for (const [x, y] of [[s * 3840, 0], [s * 3840, 3360], [0, s * 3360], [3840, s * 3360]]) {
            const [px, py] = punto(x!, y!);
            expect(px).toBeGreaterThanOrEqual(-0.01);
            expect(py).toBeGreaterThanOrEqual(-0.01);
            expect(px).toBeLessThanOrEqual(3840.01);
            expect(py).toBeLessThanOrEqual(3360.01);
          }
        }
      }
    }
  });
});
