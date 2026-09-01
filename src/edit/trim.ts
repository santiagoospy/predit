/**
 * Las reglas del recorte, aparte del componente que las dibuja: son aritmetica
 * pura y asi se pueden probar sin navegador.
 */

/** Un cuadro del archivo, en segundos. Es la separacion minima entre entrada y salida. */
export function unCuadro(fps: number): number {
  return 1 / (Number.isFinite(fps) && fps > 0 ? fps : 25);
}

/** Convierte un toque sobre la barra en un segundo del clip. */
export function segundosDesdeX(
  clientX: number,
  rect: { left: number; width: number },
  duracion: number,
): number {
  if (rect.width <= 0 || duracion <= 0) return 0;
  const fraccion = (clientX - rect.left) / rect.width;
  return Math.min(duracion, Math.max(0, fraccion * duracion));
}

/**
 * La entrada nunca alcanza a la salida: siempre queda al menos un cuadro de
 * material entre las dos, porque un clip de cero cuadros no se puede exportar.
 */
export function limitarEntrada(valor: number, trimOut: number, fps: number): number {
  const maximo = Math.max(0, trimOut - unCuadro(fps));
  return Math.max(0, Math.min(maximo, valor));
}

/** La de al lado, mas el tope del final del clip. */
export function limitarSalida(
  valor: number,
  trimIn: number,
  fps: number,
  duracion: number,
): number {
  const minimo = Math.min(duracion, trimIn + unCuadro(fps));
  return Math.min(duracion, Math.max(minimo, valor));
}

/**
 * Tiempo con decimas: 0:04.1. `formatDuration` redondea a segundos enteros, que
 * alcanza para listar clips pero no para cortar: dos marcas separadas por medio
 * segundo se leen iguales.
 */
export function formatSeconds(seconds: number): string {
  const decimas = Math.round(Math.max(0, seconds) * 10);
  const minutos = Math.floor(decimas / 600);
  const resto = decimas - minutos * 600;
  const segundos = Math.floor(resto / 10);
  return `${minutos}:${segundos.toString().padStart(2, '0')}.${resto % 10}`;
}
