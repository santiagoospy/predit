/**
 * Partir un clip en dos, aparte del componente que lo dispara: es aritmetica
 * sobre las marcas de recorte y asi se puede probar sin navegador.
 */

/** Cuanto se le perdona a la cuenta, en proporcion a un cuadro. */
const TOLERANCIA = 1e-6;

/**
 * Las marcas nuevas que deja un corte: la salida del pedazo de la izquierda y
 * la entrada del de la derecha. Son el mismo segundo, porque la entrada es
 * inclusiva y la salida exclusiva -igual que en el resto del proyecto- y asi
 * los dos pedazos no comparten un cuadro ni se pierde ninguno.
 */
export interface Corte {
  izquierda: number;
  derecha: number;
}

/**
 * Donde cortar un clip, o null si ahi no se puede.
 *
 * No se puede si el corte cae fuera del recorte, o si a alguno de los dos lados
 * le quedaria menos de un `paso` de material: es la misma regla que ya imponen
 * `limitarEntrada` y `limitarSalida` en trim.ts, porque un clip de cero cuadros
 * no se exporta.
 *
 * `paso` va en segundos: un cuadro del video, o sea `unCuadro(fps)`.
 */
export function partir(
  clip: { trimIn: number; trimOut: number },
  corte: number,
  paso: number,
): Corte | null {
  if (!Number.isFinite(corte) || !Number.isFinite(paso) || paso <= 0) return null;
  // Con una tolerancia porque las marcas son sumas y restas de segundos con
  // decimales: un corte a exactamente un cuadro de la salida da 0.0399999... y
  // sin esto se rechazaria un corte que es perfectamente valido.
  const minimo = paso * (1 - TOLERANCIA);
  if (corte - clip.trimIn < minimo) return null;
  if (clip.trimOut - corte < minimo) return null;
  return { izquierda: corte, derecha: corte };
}
