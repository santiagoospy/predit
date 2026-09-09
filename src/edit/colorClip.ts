/**
 * A que color del ciclo le toca a un clip. Estable por `id` y no por posicion:
 * reordenar la tira no tiene que repintar el montaje entero.
 *
 * El hash es el truco de siempre para un color determinista y barato: el
 * mismo id da siempre el mismo numero, en cualquier sesion y sin que haga
 * falta guardar nada.
 */
const CANTIDAD_COLORES = 6;

export function colorDeClip(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % CANTIDAD_COLORES) + 1;
}

/** Listo para `style={{ '--clip': varClipDe(id) } as CSSProperties}`. */
export function varClipDe(id: string): string {
  return `var(--clip-${colorDeClip(id)})`;
}
