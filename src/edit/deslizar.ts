/**
 * El envion de la tira cuando se la corre con el dedo, aparte del componente
 * que lo dibuja: es aritmetica sobre posiciones y tiempos, y asi se puede
 * probar sin navegador.
 *
 * Hace falta porque la tira ya no se scrollea sola: arriba de un chip el gesto
 * horizontal es nuestro (`touch-action: pan-y`), y con el se fue tambien la
 * inercia que ponia el navegador. Esto la repone.
 */

/** Donde estaba el dedo y cuando, para medirle la velocidad al final. */
export interface Muestra {
  x: number;
  t: number;
}

/**
 * Cuanto para atras se mira para calcular la velocidad. Todo el gesto no sirve:
 * si alguien arrastra medio segundo y frena antes de levantar el dedo, el
 * promedio del recorrido entero diria que venia rapido y la tira saldria
 * disparada justo cuando la estaba parando.
 */
const MEMORIA_MS = 90;

/** Por debajo de esto la tira ya esta quieta y no vale seguir el bucle. */
const QUIETA = 0.02;

/** Cuanto de la velocidad sobrevive a cada milisegundo. */
const FRICCION = 0.995;

/**
 * La velocidad con la que se levanto el dedo, en pixeles por milisegundo.
 * Positiva es el dedo yendo a la derecha.
 */
export function velocidadDe(muestras: readonly Muestra[]): number {
  const ultima = muestras[muestras.length - 1];
  if (!ultima) return 0;

  // La mas vieja que todavia entra en la ventana; si no hay ninguna, la primera.
  let primera = ultima;
  for (const m of muestras) {
    if (ultima.t - m.t <= MEMORIA_MS) {
      primera = m;
      break;
    }
  }

  const dt = ultima.t - primera.t;
  if (dt <= 0) return 0;
  return (ultima.x - primera.x) / dt;
}

/** Lo que queda del envion despues de `ms`, y cuanto se corrio en el camino. */
export function decaer(velocidad: number, ms: number): { velocidad: number; avance: number } {
  if (ms <= 0) return { velocidad, avance: 0 };
  return { velocidad: velocidad * Math.pow(FRICCION, ms), avance: velocidad * ms };
}

/** Si el envion ya es tan lento que da lo mismo cortarlo. */
export function seFreno(velocidad: number): boolean {
  return !Number.isFinite(velocidad) || Math.abs(velocidad) < QUIETA;
}
