/**
 * Cuaterniones: lo minimo para orientar una camara en el espacio.
 *
 * Se usan cuaterniones y no angulos de Euler porque acumular miles de
 * rotaciones chiquitas con Euler se rompe: los ejes se alinean, aparece el
 * bloqueo de cardan y la camara pega un tiron. Un cuaternion se compone y se
 * interpola sin ninguno de esos problemas, que es justo lo que hace falta para
 * integrar dos mil mediciones por segundo.
 *
 * La convencion es [w, x, y, z] con w primero, y todo se asume unitario: son
 * rotaciones puras, nunca escalas.
 */

export type Quat = readonly [number, number, number, number];

export const IDENTIDAD: Quat = [1, 0, 0, 0];

/** Aplicar b y despues a. El orden importa: las rotaciones no conmutan. */
export function multiplicar(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/**
 * La rotacion inversa.
 *
 * Para un cuaternion unitario alcanza con dar vuelta el signo de la parte
 * vectorial, que es mucho mas barato que invertir de verdad.
 */
export function inverso(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function normalizar(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0) return IDENTIDAD;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * La rotacion que produce girar a cierta velocidad angular durante un rato.
 *
 * `velocidad` esta en radianes por segundo por eje. Con angulos muy chicos
 * -que es el caso, porque el paso es de medio milisegundo- el seno se va a
 * cero y el eje queda indefinido, asi que ahi se devuelve la identidad en vez
 * de dividir por cero.
 */
export function desdeVelocidad(velocidad: readonly [number, number, number], dt: number): Quat {
  const [wx, wy, wz] = velocidad;
  const magnitud = Math.hypot(wx, wy, wz);
  const angulo = magnitud * dt;
  if (angulo < 1e-12) return IDENTIDAD;
  const mitad = angulo / 2;
  const k = Math.sin(mitad) / magnitud;
  return [Math.cos(mitad), wx * k, wy * k, wz * k];
}

/**
 * Interpolacion sobre la esfera: el camino mas corto entre dos orientaciones.
 *
 * Si los dos cuaterniones estan en hemisferios opuestos se da vuelta uno: q y
 * -q son la MISMA rotacion, pero interpolar entre ellos sin corregir el signo
 * da la vuelta larga, y en una camara eso se ve como un giro completo.
 */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let coseno = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let destino: Quat = b;
  if (coseno < 0) {
    destino = [-b[0], -b[1], -b[2], -b[3]];
    coseno = -coseno;
  }
  // Casi paralelos: el seno del angulo tiende a cero y la formula explota. Una
  // interpolacion lineal normalizada es indistinguible a esa distancia.
  if (coseno > 0.9995) {
    return normalizar([
      a[0] + (destino[0] - a[0]) * t,
      a[1] + (destino[1] - a[1]) * t,
      a[2] + (destino[2] - a[2]) * t,
      a[3] + (destino[3] - a[3]) * t,
    ]);
  }
  const angulo = Math.acos(coseno);
  const seno = Math.sin(angulo);
  const ka = Math.sin((1 - t) * angulo) / seno;
  const kb = Math.sin(t * angulo) / seno;
  return [
    a[0] * ka + destino[0] * kb,
    a[1] * ka + destino[1] * kb,
    a[2] * ka + destino[2] * kb,
    a[3] * ka + destino[3] * kb,
  ];
}

/**
 * La matriz de rotacion 3x3, en orden por filas.
 *
 * Es lo que consume el shader: una vez que la orientacion esta resuelta, la GPU
 * solo necesita multiplicar vectores.
 */
export function aMatriz(q: Quat): number[] {
  const [w, x, y, z] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  return [
    1 - 2 * (yy + zz), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (xx + zz), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (xx + yy),
  ];
}

/** El angulo total de la rotacion, en radianes. Sirve para medir cuanto corrige. */
export function angulo(q: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q[0])));
}
