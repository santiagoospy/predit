import { useCallback, useRef, useState } from 'react';

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
  /** Adonde saltar. Se llama al soltar, no en cada pixel del arrastre. */
  onSeek: (segundos: number) => void;
}

/**
 * La barra del montaje entero: un tramo por clip, ancho segun lo que dura, y un
 * cabezal que se arrastra para pararse en cualquier segundo del proyecto.
 *
 * Es la unica forma de decir "reproduci desde aca": el `Recortador` de la
 * pestana clip habla en segundos del ARCHIVO del clip seleccionado, asi que con
 * doce clips no habia manera de saltar a la mitad del montaje.
 *
 * El salto se manda recien al soltar y no mientras el dedo se mueve: cruzar de
 * clip recarga el `<video>`, y hacerlo en cada pixel dejaba el arrastre
 * inservible. Durante el gesto el cabezal se dibuja del estado local, asi que
 * igual se ve seguir al dedo.
 */
export function BarraLinea({
  tramos,
  duracionTotal,
  posicion,
  selectedId,
  deshabilitado,
  onSeek,
}: BarraLineaProps) {
  const arrastrando = useRef(false);
  /** Los segundos bajo el dedo mientras dura el gesto; null si no hay gesto. */
  const [enElDedo, setEnElDedo] = useState<number | null>(null);

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
      setEnElDedo(leer(e.clientX, e.currentTarget.getBoundingClientRect()));
    },
    [deshabilitado, duracionTotal, leer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!arrastrando.current) return;
      setEnElDedo(leer(e.clientX, e.currentTarget.getBoundingClientRect()));
    },
    [leer],
  );

  const soltar = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!arrastrando.current) return;
      arrastrando.current = false;
      const segundos = leer(e.clientX, e.currentTarget.getBoundingClientRect());
      setEnElDedo(null);
      onSeek(segundos);
    },
    [leer, onSeek],
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

      <div className="barra-linea-pie">
        <span className="recortador-posicion">
          {formatSeconds(mostrado)} / {formatSeconds(duracionTotal)}
        </span>
      </div>
    </div>
  );
}
