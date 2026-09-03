import { useCallback, useEffect, useRef, useState } from 'react';

import { formatDuration } from '../media/probe';
import {
  desplazamientoDe,
  destinoDelArrastre,
  offsetDelSlot,
  type Caja,
} from './orden';
import { clipOutputDuration, type TimelineClip } from './types';

/**
 * Cuanto hay que mantener apretado para enganchar un clip. Menos que esto y un
 * toque comun engancharia sin querer; mas, y se siente trabado.
 */
const ENGANCHE_MS = 250;

/**
 * Si el dedo se corre mas que esto antes de que enganche, el gesto era scrollear
 * la tira y el enganche se cancela.
 */
const TOLERANCIA_PX = 8;

/** Tiene que coincidir con el `gap` de `.tira` en el CSS. */
const GAP_PX = 8;

/** A que distancia del borde la tira empieza a correrse sola. */
const BORDE_PX = 44;

/** Cuantos pixeles por cuadro se corre la tira sola. */
const VELOCIDAD_PX = 10;

/** Lo que dura la bajada del chip a su hueco al soltar. Igual que en el CSS. */
const BAJADA_MS = 180;

interface Arrastre {
  desde: number;
  destino: number;
  /** Donde arranco el dedo, en coordenadas de contenido de la tira. */
  x0: number;
  /** Cuanto se corrio el chip enganchado desde su lugar. */
  offset: number;
  /** El mapa de los chips al momento de enganchar, que ya no se recalcula. */
  cajas: Caja[];
  /** Ya se solto y el chip esta bajando a su hueco. */
  bajando: boolean;
}

export interface TiraClipsProps {
  clips: TimelineClip[];
  selectedId: string | null;
  deshabilitado: boolean;
  onSelect: (id: string) => void;
  onReordenar: (desde: number, hasta: number) => void;
}

/**
 * La tira de clips: un chip numerado por clip, y el orden del montaje se cambia
 * arrastrandolos.
 *
 * El enganche es por toque sostenido y no inmediato porque la tira ya usa el
 * arrastre horizontal para scrollear y el toque corto para elegir clip. Los
 * botones "mover" de la pestana clip hacen lo mismo de a un lugar, y son la via
 * de teclado.
 */
export function TiraClips({
  clips,
  selectedId,
  deshabilitado,
  onSelect,
  onReordenar,
}: TiraClipsProps) {
  const tiraRef = useRef<HTMLElement>(null);
  const chipsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const [arrastre, setArrastre] = useState<Arrastre | null>(null);
  /** El espejo del estado: los handlers del pointer lo leen sin re-suscribirse. */
  const arrastreRef = useRef<Arrastre | null>(null);
  arrastreRef.current = arrastre;

  const relojRef = useRef<number | null>(null);
  const partidaRef = useRef<{ x: number; y: number; indice: number } | null>(null);
  /** El ultimo X del dedo, que el auto-scroll necesita aunque nadie se mueva. */
  const ultimoXRef = useRef(0);

  /** De coordenadas de pantalla a coordenadas de contenido de la tira. */
  const xContenido = useCallback((clientX: number) => {
    const tira = tiraRef.current;
    if (!tira) return clientX;
    return clientX - tira.getBoundingClientRect().left + tira.scrollLeft;
  }, []);

  const cancelarEnganche = useCallback(() => {
    if (relojRef.current !== null) {
      clearTimeout(relojRef.current);
      relojRef.current = null;
    }
    partidaRef.current = null;
  }, []);

  const recalcular = useCallback(
    (clientX: number) => {
      const a = arrastreRef.current;
      if (!a || a.bajando) return;
      const propia = a.cajas[a.desde];
      if (!propia) return;
      const offset = xContenido(clientX) - a.x0;
      const centro = propia.left + propia.width / 2 + offset;
      setArrastre({ ...a, offset, destino: destinoDelArrastre(centro, a.cajas, a.desde) });
    },
    [xContenido],
  );

  const enganchar = useCallback(
    (indice: number, clientX: number) => {
      const tira = tiraRef.current;
      if (!tira) return;
      const rect = tira.getBoundingClientRect();
      const cajas: Caja[] = [];
      for (let i = 0; i < clips.length; i++) {
        const el = chipsRef.current[i];
        if (!el) return;
        const r = el.getBoundingClientRect();
        cajas.push({ left: r.left - rect.left + tira.scrollLeft, width: r.width });
      }
      ultimoXRef.current = clientX;
      setArrastre({
        desde: indice,
        destino: indice,
        x0: xContenido(clientX),
        offset: 0,
        cajas,
        bajando: false,
      });
    },
    [clips.length, xContenido],
  );

  const soltar = useCallback(() => {
    cancelarEnganche();
    const a = arrastreRef.current;
    if (!a || a.bajando) return;

    if (a.destino === a.desde) {
      setArrastre(null);
      return;
    }

    // Primero el chip baja a su hueco, y recien cuando llego se cambia el orden
    // de verdad. Reordenar en el acto lo haria saltar desde donde quedo el dedo.
    setArrastre({ ...a, offset: offsetDelSlot(a.cajas, a.desde, a.destino), bajando: true });
    window.setTimeout(() => {
      onReordenar(a.desde, a.destino);
      setArrastre(null);
    }, BAJADA_MS);
  }, [cancelarEnganche, onReordenar]);

  /**
   * Con un arrastre en curso el dedo es del chip, no de la tira. `touch-action`
   * no alcanza: en iOS el navegador ya decidio que el gesto era un pan cuando el
   * enganche recien esta empezando, y solo un preventDefault sobre el touchmove
   * -que React no deja registrar, porque sus listeners son pasivos- lo frena.
   */
  useEffect(() => {
    const tira = tiraRef.current;
    if (!tira) return;
    const frenar = (e: TouchEvent) => {
      if (arrastreRef.current) e.preventDefault();
    };
    tira.addEventListener('touchmove', frenar, { passive: false });
    return () => tira.removeEventListener('touchmove', frenar);
  }, []);

  /** Arrastrar contra un borde corre la tira sola, para llegar a los que no entran. */
  const arrastrando = arrastre !== null && !arrastre.bajando;
  useEffect(() => {
    if (!arrastrando) return;
    let cuadro = 0;
    const paso = () => {
      const tira = tiraRef.current;
      if (tira && arrastreRef.current && !arrastreRef.current.bajando) {
        const rect = tira.getBoundingClientRect();
        const x = ultimoXRef.current;
        const delta =
          x - rect.left < BORDE_PX
            ? -VELOCIDAD_PX
            : rect.right - x < BORDE_PX
              ? VELOCIDAD_PX
              : 0;
        if (delta !== 0) {
          const antes = tira.scrollLeft;
          tira.scrollLeft += delta;
          // Solo si de verdad se corrio: contra el tope no hay nada que rehacer.
          if (tira.scrollLeft !== antes) recalcular(x);
        }
      }
      cuadro = requestAnimationFrame(paso);
    };
    cuadro = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(cuadro);
  }, [arrastrando, recalcular]);

  // Desmontarse a mitad de un arrastre no debe dejar el reloj corriendo.
  useEffect(() => cancelarEnganche, [cancelarEnganche]);

  if (clips.length === 0) return null;

  return (
    <section
      className={`tira${arrastre ? ' reordenando' : ''}`}
      ref={tiraRef}
      aria-label="clips del montaje"
    >
      {clips.map((c, i) => {
        const enganchado = arrastre !== null && arrastre.desde === i;
        const dx = !arrastre
          ? 0
          : enganchado
            ? arrastre.offset
            : desplazamientoDe(i, arrastre.desde, arrastre.destino, arrastre.cajas, GAP_PX);

        return (
          <button
            key={c.id}
            ref={(el) => {
              chipsRef.current[i] = el;
            }}
            className={
              `tira-clip${c.id === selectedId ? ' activo' : ''}` +
              `${enganchado ? ' enganchado' : ''}${enganchado && arrastre.bajando ? ' bajando' : ''}`
            }
            style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
            aria-pressed={c.id === selectedId}
            title={`${c.info.name} · ${formatDuration(clipOutputDuration(c))}`}
            onClick={() => onSelect(c.id)}
            onPointerDown={(e) => {
              if (deshabilitado || clips.length < 2) return;
              partidaRef.current = { x: e.clientX, y: e.clientY, indice: i };
              const chip = e.currentTarget;
              const pointerId = e.pointerId;
              relojRef.current = window.setTimeout(() => {
                relojRef.current = null;
                const p = partidaRef.current;
                if (!p) return;
                chip.setPointerCapture(pointerId);
                enganchar(p.indice, p.x);
              }, ENGANCHE_MS);
            }}
            onPointerMove={(e) => {
              const p = partidaRef.current;
              if (relojRef.current !== null && p) {
                // Todavia no engancho: si el dedo se corrio, era un scroll.
                if (
                  Math.abs(e.clientX - p.x) > TOLERANCIA_PX ||
                  Math.abs(e.clientY - p.y) > TOLERANCIA_PX
                ) {
                  cancelarEnganche();
                }
                return;
              }
              if (!arrastreRef.current) return;
              ultimoXRef.current = e.clientX;
              recalcular(e.clientX);
            }}
            onPointerUp={soltar}
            onPointerCancel={soltar}
            onContextMenu={(e) => e.preventDefault()}
          >
            {String(i + 1).padStart(2, '0')}
            {c.warnings.length > 0 && (
              <span className="aviso-badge" title={c.warnings.join(' ')}>
                ⚠
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}
