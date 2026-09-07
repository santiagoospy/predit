import { useCallback, useEffect, useRef, useState } from 'react';

import { formatDuration } from '../media/probe';
import { decaer, seFreno, velocidadDe, type Muestra } from './deslizar';
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
 * Si el dedo se corre mas que esto antes de que enganche, el gesto no era
 * enganchar: era correr la tira, o scrollear la pagina.
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

/** El techo del paso de la inercia: una pestana en segundo plano no da un salto. */
const PASO_MAX_MS = 32;

/**
 * En que se convirtio el toque que arranco sobre un chip.
 *
 * 'espera' es el rato en que todavia puede ser cualquiera de las tres cosas. Se
 * decide por el primer movimiento que pase la tolerancia, o por el reloj del
 * enganche si el dedo se queda quieto.
 */
type Modo = 'espera' | 'tira' | 'chip';

interface Gesto {
  indice: number;
  x0: number;
  y0: number;
  /** Donde estaba la tira al empezar: correrla es esto menos lo que fue el dedo. */
  scroll0: number;
  modo: Modo;
}

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
 * arrastre horizontal para correrse y el toque corto para elegir clip. Los
 * botones "mover" de la pestana clip hacen lo mismo de a un lugar, y son la via
 * de teclado.
 *
 * Arriba de un chip el gesto horizontal es NUESTRO: el chip lleva
 * `touch-action: pan-y`, asi que el navegador solo se queda con el vertical -el
 * de scrollear la pagina- y nunca con el de la tira. Sin eso, con la tira
 * desbordada el navegador se quedaba con el toque apenas rozaba la pantalla,
 * mandaba un `pointercancel` y mataba el enganche antes de que llegara a
 * cumplirse: el arrastre era imposible justo cuando mas clips habia. El precio
 * es que correr la tira lo hacemos a mano, inercia incluida (ver deslizar.ts).
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
  const gestoRef = useRef<Gesto | null>(null);
  /** El ultimo X del dedo, que el auto-scroll necesita aunque nadie se mueva. */
  const ultimoXRef = useRef(0);
  /** El rastro del dedo, para saber con cuanto envion se lo levanto. */
  const muestrasRef = useRef<Muestra[]>([]);
  const inerciaRef = useRef<number | null>(null);
  /**
   * Si el toque termino siendo un gesto y no un toque. El click llega igual
   * despues del pointerup, y sin esto correr la tira elegiria de paso el chip
   * que quedo abajo del dedo.
   */
  const huboGestoRef = useRef(false);

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
  }, []);

  const frenarInercia = useCallback(() => {
    if (inerciaRef.current !== null) {
      cancelAnimationFrame(inerciaRef.current);
      inerciaRef.current = null;
    }
  }, []);

  /** Al soltar, la tira sigue corriendo y frena sola, como lo haria el navegador. */
  const lanzarInercia = useCallback(() => {
    let velocidad = velocidadDe(muestrasRef.current);
    if (seFreno(velocidad)) return;

    let anterior = performance.now();
    const paso = (ahora: number) => {
      const tira = tiraRef.current;
      if (!tira) {
        inerciaRef.current = null;
        return;
      }
      const ms = Math.min(PASO_MAX_MS, ahora - anterior);
      anterior = ahora;
      const siguiente = decaer(velocidad, ms);
      velocidad = siguiente.velocidad;

      // El dedo yendo a la derecha destapa lo que hay a la IZQUIERDA, o sea que
      // el scroll baja: por eso se resta.
      const antes = tira.scrollLeft;
      tira.scrollLeft = antes - siguiente.avance;
      // Contra el tope el scroll no se movio y no hay nada mas que hacer.
      if (seFreno(velocidad) || tira.scrollLeft === antes) {
        inerciaRef.current = null;
        return;
      }
      inerciaRef.current = requestAnimationFrame(paso);
    };
    inerciaRef.current = requestAnimationFrame(paso);
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

  const soltarChip = useCallback(() => {
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
  }, [onReordenar]);

  const empezar = useCallback(
    (indice: number, e: React.PointerEvent<HTMLButtonElement>) => {
      frenarInercia();
      cancelarEnganche();
      huboGestoRef.current = false;

      gestoRef.current = {
        indice,
        x0: e.clientX,
        y0: e.clientY,
        scroll0: tiraRef.current?.scrollLeft ?? 0,
        modo: 'espera',
      };
      muestrasRef.current = [{ x: e.clientX, t: e.timeStamp }];

      // El toque es del chip desde el arranque: sin esto, correr la tira se
      // cortaria apenas el dedo pasa por encima del chip de al lado.
      e.currentTarget.setPointerCapture(e.pointerId);

      if (deshabilitado || clips.length < 2) return;
      relojRef.current = window.setTimeout(() => {
        relojRef.current = null;
        const g = gestoRef.current;
        if (!g || g.modo !== 'espera') return;
        g.modo = 'chip';
        huboGestoRef.current = true;
        enganchar(g.indice, g.x0);
      }, ENGANCHE_MS);
    },
    [cancelarEnganche, clips.length, deshabilitado, enganchar, frenarInercia],
  );

  const mover = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const g = gestoRef.current;
      if (!g) return;
      muestrasRef.current.push({ x: e.clientX, t: e.timeStamp });

      if (g.modo === 'espera') {
        const dx = e.clientX - g.x0;
        const dy = e.clientY - g.y0;
        if (Math.abs(dx) > TOLERANCIA_PX && Math.abs(dx) >= Math.abs(dy)) {
          // Se fue para el costado: el gesto era correr la tira.
          cancelarEnganche();
          g.modo = 'tira';
          huboGestoRef.current = true;
        } else if (Math.abs(dy) > TOLERANCIA_PX) {
          // Se fue para arriba o para abajo: eso es el scroll de la pagina, que
          // el navegador se lleva solo. Nosotros nos borramos del gesto.
          cancelarEnganche();
          gestoRef.current = null;
          return;
        } else {
          return;
        }
      }

      if (g.modo === 'tira') {
        const tira = tiraRef.current;
        if (tira) tira.scrollLeft = g.scroll0 - (e.clientX - g.x0);
        return;
      }

      ultimoXRef.current = e.clientX;
      recalcular(e.clientX);
    },
    [cancelarEnganche, recalcular],
  );

  const terminar = useCallback(() => {
    cancelarEnganche();
    const g = gestoRef.current;
    gestoRef.current = null;
    if (g?.modo === 'tira') lanzarInercia();
    else if (g?.modo === 'chip') soltarChip();
  }, [cancelarEnganche, lanzarInercia, soltarChip]);

  /**
   * Con un chip enganchado el dedo es del chip y de nadie mas. `pan-y` sigue
   * dejandole al navegador el gesto vertical, y un arrastre que arranca de
   * costado pero se va para abajo terminaria scrolleando la pagina y matando el
   * enganche. Aca si el preventDefault funciona: el enganche pide 250ms de dedo
   * quieto, asi que cuando llega el primer movimiento el navegador todavia no
   * decidio nada. Va sobre el nodo porque React registra sus listeners como
   * pasivos y desde uno pasivo no se puede frenar nada.
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

  // Desmontarse a mitad de un gesto no debe dejar nada corriendo.
  useEffect(
    () => () => {
      cancelarEnganche();
      frenarInercia();
    },
    [cancelarEnganche, frenarInercia],
  );

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
            onClick={() => {
              // Correr la tira o arrastrar un chip no es elegirlo. Hay que
              // descartar ese click a mano: el navegador ya no lo hace por
              // nosotros, porque el gesto horizontal no lo maneja el.
              if (huboGestoRef.current) {
                huboGestoRef.current = false;
                return;
              }
              onSelect(c.id);
            }}
            onPointerDown={(e) => empezar(i, e)}
            onPointerMove={mover}
            onPointerUp={terminar}
            onPointerCancel={terminar}
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
