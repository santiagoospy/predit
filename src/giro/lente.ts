/**
 * El modelo de ojo de pez, con los coeficientes de un perfil de Gyroflow.
 *
 * Un lente normal se comporta como un agujero de alfiler: un rayo a X grados
 * del eje cae a `f * tan(X)` pixeles del centro y las rectas del mundo salen
 * rectas. Un ojo de pez comprime hacia los bordes para meter 150 grados en el
 * cuadro, y eso tiene dos consecuencias para estabilizar:
 *
 *  - la misma rotacion mueve los bordes MENOS que el centro. Corregir con el
 *    modelo de agujero de alfiler deja bien el centro y mal toda la periferia;
 *  - el horizonte sale curvo, y solo se endereza con el modelo del lente.
 *
 * El modelo es el de OpenCV para ojo de pez (`cv::fisheye`), que es el que usa
 * Gyroflow en sus perfiles: con `theta` el angulo del rayo respecto del eje,
 *
 *     theta_d = theta * (1 + k1*theta^2 + k2*theta^4 + k3*theta^6 + k4*theta^8)
 *     pixel   = f * theta_d * (direccion en el plano) + centro
 *
 * Los coeficientes vienen de la calibracion de Gyroflow para cada camara y
 * modo. El de abajo (HERO11 Black, Wide, 8:7) es el que Gyroflow eligio para
 * el clip de referencia (GX010389.gyroflow, una HERO13 en 3840x3360): las dos
 * camaras comparten lente.
 *
 * La misma cuenta esta escrita en GLSL en color/shader.ts. Si cambia una tiene
 * que cambiar la otra; `proyectarLente` es la referencia y lo que prueban los
 * tests.
 */

export interface PerfilLente {
  /** El nombre del perfil, tal como lo escribe Gyroflow. */
  nombre: string;
  /** Focal en pixeles, por eje. En un lente bien centrado son casi iguales. */
  fx: number;
  fy: number;
  /** El centro optico en pixeles. No es el centro de la imagen. */
  cx: number;
  cy: number;
  /** Los cuatro coeficientes de distorsion: k1..k4. */
  k: readonly [number, number, number, number];
  /** A que resolucion se calibro. Los pixeles de arriba son de ESA imagen. */
  ancho: number;
  alto: number;
}

/**
 * Lee un archivo `.gyroflow` (o solo su `calibration_data`, o un perfil de
 * lente suelto de Gyroflow: los tres traen la misma estructura).
 *
 * Devuelve null si no tiene lo que hace falta: es preferible "no hay perfil" a
 * un perfil con ceros que deforme la imagen en silencio.
 */
export function perfilDesdeGyroflow(json: unknown): PerfilLente | null {
  if (!json || typeof json !== 'object') return null;
  const raiz = json as Record<string, unknown>;
  const datos = (raiz['calibration_data'] ?? raiz) as Record<string, unknown>;

  const fisheye = datos['fisheye_params'] as Record<string, unknown> | undefined;
  const matriz = fisheye?.['camera_matrix'] as unknown;
  const coefs = fisheye?.['distortion_coeffs'] as unknown;
  const dimension = (datos['calib_dimension'] ?? datos['orig_dimension']) as
    | Record<string, unknown>
    | undefined;

  if (!Array.isArray(matriz) || matriz.length !== 3) return null;
  if (!Array.isArray(coefs) || coefs.length < 4) return null;
  const fila0 = matriz[0] as unknown;
  const fila1 = matriz[1] as unknown;
  if (!Array.isArray(fila0) || !Array.isArray(fila1)) return null;

  const fx = Number(fila0[0]);
  const cx = Number(fila0[2]);
  const fy = Number(fila1[1]);
  const cy = Number(fila1[2]);
  const ancho = Number(dimension?.['w']);
  const alto = Number(dimension?.['h']);
  const k = coefs.slice(0, 4).map(Number) as [number, number, number, number];

  if (![fx, fy, cx, cy, ancho, alto, ...k].every(Number.isFinite)) return null;
  if (fx <= 0 || fy <= 0 || ancho <= 0 || alto <= 0) return null;

  return {
    nombre: typeof datos['name'] === 'string' ? datos['name'] : 'perfil de Gyroflow',
    fx,
    fy,
    cx,
    cy,
    k,
    ancho,
    alto,
  };
}

/**
 * Lleva el perfil a otra resolucion de la misma imagen.
 *
 * Los coeficientes k son adimensionales y no cambian; la focal y el centro
 * estan en pixeles y escalan con la imagen. Si el aspecto es distinto no es la
 * misma imagen -es otro modo de la camara- y el perfil no sirve: se devuelve
 * null antes que aplicar mal.
 */
export function escalarPerfil(perfil: PerfilLente, ancho: number, alto: number): PerfilLente | null {
  if (!(ancho > 0) || !(alto > 0)) return null;
  const sx = ancho / perfil.ancho;
  const sy = alto / perfil.alto;
  if (Math.abs(sx / sy - 1) > 0.01) return null;
  return { ...perfil, fx: perfil.fx * sx, fy: perfil.fy * sy, cx: perfil.cx * sx, cy: perfil.cy * sy, ancho, alto };
}

/**
 * Proyecta un rayo de la camara (x derecha, y abajo, z adelante) al pixel del
 * ojo de pez. Es la referencia del GLSL de color/shader.ts.
 *
 * Un rayo que apunta hacia atras no cae en la imagen: se devuelve un punto
 * lejos, afuera, para que los chequeos de borde lo cuenten como afuera.
 */
export function proyectarLente(p: PerfilLente, x: number, y: number, z: number): [number, number] {
  if (z <= 1e-9) return [-1e9, -1e9];
  const a = x / z;
  const b = y / z;
  const r = Math.hypot(a, b);
  const theta = Math.atan(r);
  const t2 = theta * theta;
  const thetaD = theta * (1 + t2 * (p.k[0] + t2 * (p.k[1] + t2 * (p.k[2] + t2 * p.k[3]))));
  const escala = r > 1e-9 ? thetaD / r : 1;
  return [p.fx * a * escala + p.cx, p.fy * b * escala + p.cy];
}

/**
 * La inversa: del pixel del ojo de pez al rayo (x, y, 1) que lo produjo.
 *
 * El polinomio no se invierte en cerrado; se resuelve theta por Newton desde
 * theta_d, que para estos coeficientes converge en tres o cuatro pasos. Es la
 * referencia del GLSL de color/shader.ts.
 */
export function desproyectarLente(p: PerfilLente, px: number, py: number): [number, number, number] {
  const a = (px - p.cx) / p.fx;
  const b = (py - p.cy) / p.fy;
  const rd = Math.hypot(a, b);
  if (rd < 1e-9) return [0, 0, 1];
  let theta = rd;
  for (let i = 0; i < 6; i++) {
    const t2 = theta * theta;
    const g = theta * (1 + t2 * (p.k[0] + t2 * (p.k[1] + t2 * (p.k[2] + t2 * p.k[3])))) - rd;
    const dg = 1 + t2 * (3 * p.k[0] + t2 * (5 * p.k[1] + t2 * (7 * p.k[2] + t2 * 9 * p.k[3])));
    theta -= g / dg;
  }
  // Mas alla de 90 grados no hay rayo hacia adelante: se planta cerca del
  // horizonte, que ya es afuera de cualquier imagen.
  theta = Math.min(Math.max(theta, 0), Math.PI / 2 - 1e-3);
  const escala = Math.tan(theta) / rd;
  return [a * escala, b * escala, 1];
}

/**
 * Los perfiles conocidos. Por ahora uno: el que Gyroflow uso para el clip de
 * referencia. Cargar cualquier `.gyroflow` desde la app es el paso siguiente.
 */
export const PERFIL_GOPRO_WIDE_8_7: PerfilLente = {
  nombre: 'GoPro_HERO11 Black_Wide_8by7',
  fx: 1703.9400859896853,
  fy: 1703.236312615633,
  cx: 1935.0695909440076,
  cy: 1676.8258911060643,
  k: [0.03139553973504779, 0.05974110122697331, -0.043366819910340776, 0.009924139209409393],
  ancho: 3840,
  alto: 3360,
};

/**
 * El perfil que corresponde a un clip, si hay uno.
 *
 * Se elige por marca y por aspecto de la imagen: el modo de la camara (Wide,
 * Linear, 16:9, 8:7) es lo que define el lente, y el aspecto es la unica huella
 * de ese modo que queda en el archivo cuando la camara no escribe su
 * calibracion. Un clip 16:9 de la misma GoPro NO es este lente.
 */
export function perfilPara(fuente: 'sony' | 'gopro', ancho: number, alto: number): PerfilLente | null {
  if (fuente !== 'gopro') return null;
  return escalarPerfil(PERFIL_GOPRO_WIDE_8_7, ancho, alto);
}
