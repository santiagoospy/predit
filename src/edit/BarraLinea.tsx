import { useCallback, useEffect, useRef, useState } from 'react';

import { formatSeconds, segundosDesdeX } from './trim';

/** Cuanto mueve el cabezal cada flecha del teclado, en segundos del montaje. */
const PASO_TECLA = 1;

/** Un clip visto desde la barra: solo lo que ocupa en el montaje. */
export interface Tramo {
  id: string;
  duracion: number;
}

export interface BarraLineaProps {
  /** Un tramo por clip, en el orden del montaje. */
  tramos: Tramo[];
  duracionTotal: number;
  /** El cabezal, en segundos de la LINEA DE TIEMPO (no del archivo). */
  posicion: number;
  selectedId: string | null;
  deshabilitado: boolean;
  /** Adonde saltar. Se llama al soltar: es el salto definitivo. */
  onSeek: (segundos: number) => void;
  /** Empieza el arrastre. Sirve para pausar lo que estuviera sonando. */
  onScrubStart?: () => void;
  /** Adonde mira el dedo AHORA, ya limitado a uno por cuadro de pantalla. */
  onScrub?: (segundos: number) => void;
  /** Termino el arrastre, despues de `onSeek`. */
  onScrubEnd?: () => void;
}

/**
 * La barra del montaje entero: un tramo por clip, ancho segun lo que dura, y un
 * cabezal que se arrastra para pararse en cualquier segundo del proyecto.
 *
 * Es la unica forma de decir "reproduci desde aca": el `Recortador` de la
 * pestana clip habla en segundos del ARCHIVO del clip seleccionado, asi que con
 * doce clips no habia manera de saltar a la mitad del montaje.
 *
 * El visor sigue al dedo durante el arrastre (`onScrub`), igual que en la barra
 * de un clip. Los `pointermove` llegan mucho mas seguido que lo que la pantalla
 * puede dibujar, asi que se acumula el ultimo segundo y se avisa una sola vez
 * por cuadro: sin eso, cruzar de clip -que recarga el `<video>`- dejaba el
 * arrastre inservible. El cabezal igual se dibuja del estado local, que no
 * depende de que el video haya llegado.
 */
export function BarraLinea({
  tramos,
  duracionTotal,
  posicion,
  selectedId,
  deshabilitado,
  onSeek,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: BarraLineaProps) {
  const arrastrando = useRef(false);
  /** Los segundos bajo el dedo mientras dura el gesto; null si no hay gesto. */
  const [enElDedo, setEnElDedo] = useState<number | null>(null);

  /** Lo ultimo que pidio el dedo y el cuadro pedido para avisarlo, si hay uno. */
  const pendiente = useRef<number | null>(null);
  const cuadro = useRef<number | null>(null);

  const cancelarCuadro = useCallback(() => {
    if (cuadro.current !== null) cancelAnimationFrame(cuadro.current);
    cuadro.current = null;
    pendiente.current = null;
  }, []);

  // Un gesto que quedo a medias no tiene que dejar un cuadro colgado.
  useEffect(() => cancelarCuadro, [cancelarCuadro]);

  /** Avisa el segundo nuevo como mucho una vez por cuadro de pantalla. */
  const avisar = useCallback(
    (segundos: number) => {
      if (!onScrub) return;
      pendiente.current = segundos;
      if (cuadro.current !== null) return;
      cuadro.current = requestAnimationFrame(() => {
        cuadro.current = null;
        const s = pendiente.current;
        pendiente.current = null;
        if (s !== null) onScrub(s);
      });
    },
    [onScrub],
  );

  const leer = useCallback(
    (clientX: number, rect: DOMRect) =>
      segundosDesdeX(clientX, rect, { desde: 0, hasta: duracionTotal }),
    [duracionTotal],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (deshabilitado || duracionTotal <= 0) return;
      arrastrando.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      const segundos = leer(e.clientX, e.currentTarget.getBoundingClientRect());
      setEnElDedo(segundos);
      onScrubStart?.();
      avisar(segundos);
    },
    [deshabilitado, duracionTotal, leer, onScrubStart, avisar],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!arrastrando.current) return;
      const segundos = leer(e.clientX, e.currentTarget.getBoundingClientRect());
      setEnElDedo(segundos);
      avisar(segundos);
    },
    [leer, avisar],
  );

  const soltar = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!arrastrando.current) return;
      arrastrando.current = false;
      const segundos = leer(e.clientX, e.currentTarget.getBoundingClientRect());
      // El cuadro pendiente ya no sirve: `onSeek` manda sobre el.
      cancelarCuadro();
      setEnElDedo(null);
      onSeek(segundos);
      onScrubEnd?.();
    },
    [leer, onSeek, onScrubEnd, cancelarCuadro],
  );

  const mostrado = enElDedo ?? posicion;
  const fraccion = duracionTotal > 0 ? Math.min(1, Math.max(0, mostrado / duracionTotal)) : 0;

  const teclas = (e: React.KeyboardEvent) => {
    if (deshabilitado) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const paso = e.key === 'ArrowLeft' ? -PASO_TECLA : PASO_TECLA;
    onSeek(Math.min(duracionTotal, Math.max(0, posicion + paso)));
  };

  return (
    <div className="barra-linea">
      <div
        className={`barra-linea-pista${deshabilitado ? ' apagada' : ''}`}
        role="slider"
        tabIndex={deshabilitado ? -1 : 0}
        aria-label="Posición en el montaje"
        aria-valuemin={0}
        aria-valuemax={duracionTotal}
        aria-valuenow={posicion}
        aria-valuetext={formatSeconds(posicion)}
        onKeyDown={teclas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={soltar}
        onPointerCancel={soltar}
      >
        {/* Los tramos se reparten por `flex-grow`: el navegador hace la regla de
            tres sola y no hay que recalcular anchos cuando se recorta un clip. */}
        {tramos.map((t) => (
          <div
            key={t.id}
            className={`barra-linea-tramo${t.id === selectedId ? ' activo' : ''}`}
            style={{ flexGrow: Math.max(t.duracion, 0.001) }}
          />
        ))}
        <div className="barra-linea-cabezal" style={{ left: `${fraccion * 100}%` }} />
      </div>

      {/* Al lado de la pista y no debajo: sobre el video, una linea propia para
          dos relojes costaba tanto alto como la pista misma. */}
      <span className="barra-linea-tiempo">
        {formatSeconds(mostrado)} / {formatSeconds(duracionTotal)}
      </span>
    </div>
  );
}
