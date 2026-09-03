/**
 * Las reglas del recorte, aparte del componente que las dibuja: son aritmetica
 * pura y asi se pueden probar sin navegador.
 */

/** Un cuadro del archivo, en segundos. Es el paso de recorte de un video. */
export function unCuadro(fps: number): number {
  return 1 / (Number.isFinite(fps) && fps > 0 ? fps : 25);
}

/** El tramo del clip que la barra dibuja de borde a borde. */
export interface Vista {
  desde: number;
  hasta: number;
}

/**
 * Cuanto aire queda a cada lado del corte, en proporcion a lo que dura. Sin el,
 * las dos manijas caerian justo en los bordes de la barra y no habria de donde
 * agarrarlas para volver a abrir el recorte.
 */
const AIRE = 0.15;

/**
 * Si la vista termina cubriendo casi todo el clip, se muestra el clip entero: un
 * zoom del 5% no agrega precision y solo mueve la barra bajo el dedo por nada.
 */
const CASI_TODO = 0.9;

/**
 * El tramo que conviene dibujar para un recorte dado. Con el clip entero a la
 * vista, un corte de 3 segundos dentro de una toma de 2 minutos queda apretado
 * en unos pocos pixeles y no hay forma de mover el cabezal ahi adentro con el
 * dedo. La barra se estira al corte -mas el aire de los costados- asi el pedazo
 * que sobrevive ocupa el ancho entero y se puede recorrer de atras para
 * adelante.
 */
export function vistaDeLaBarra(trimIn: number, trimOut: number, duracion: number): Vista {
  const todo = { desde: 0, hasta: Math.max(0, duracion) };
  if (duracion <= 0 || trimOut <= trimIn) return todo;

  const margen = (trimOut - trimIn) * AIRE;
  const desde = Math.max(0, trimIn - margen);
  const hasta = Math.min(duracion, trimOut + margen);
  if (hasta - desde >= duracion * CASI_TODO) return todo;
  return { desde, hasta };
}

/** Convierte un toque sobre la barra en un segundo del clip. */
export function segundosDesdeX(
  clientX: number,
  rect: { left: number; width: number },
  vista: Vista,
): number {
  const largo = vista.hasta - vista.desde;
  if (rect.width <= 0 || largo <= 0) return vista.desde;
  const fraccion = (clientX - rect.left) / rect.width;
  return vista.desde + Math.min(1, Math.max(0, fraccion)) * largo;
}

/** Donde cae un segundo del clip dentro de la barra, de 0 a 1. */
export function fraccionEnLaVista(segundos: number, vista: Vista): number {
  const largo = vista.hasta - vista.desde;
  if (largo <= 0) return 0;
  return Math.min(1, Math.max(0, (segundos - vista.desde) / largo));
}

/**
 * La entrada nunca alcanza a la salida: siempre queda al menos un paso de
 * material entre las dos, porque un clip de cero cuadros no se puede exportar.
 *
 * `paso` va en segundos, no en fps: es un cuadro en un video (`unCuadro`) y una
 * decima en la musica, que no tiene cuadros.
 */
export function limitarEntrada(valor: number, trimOut: number, paso: number): number {
  const maximo = Math.max(0, trimOut - paso);
  return Math.max(0, Math.min(maximo, valor));
}

/** La de al lado, mas el tope del final del clip. */
export function limitarSalida(
  valor: number,
  trimIn: number,
  paso: number,
  duracion: number,
): number {
  const minimo = Math.min(duracion, trimIn + paso);
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
