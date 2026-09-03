import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  formatSeconds,
  fraccionEnLaVista,
  limitarEntrada,
  limitarSalida,
  segundosDesdeX,
  vistaDeLaBarra,
  type Vista,
} from './trim';

/**
 * Cuanto puede errarle el dedo a una manija y agarrarla igual. Un toque mas
 * lejos que esto mueve el cabezal, que es lo que se quiere al tocar en el medio.
 */
const TOLERANCIA_PX = 22;

type Agarre = 'entrada' | 'salida' | 'cabezal';

export interface RecortadorProps {
  duracion: number;
  trimIn: number;
  trimOut: number;
  currentTime: number;
  /**
   * El salto del ajuste fino, en segundos, que es tambien la separacion minima
   * entre entrada y salida: un cuadro en un video, una decima en la musica.
   */
  paso: number;
  /** El bloque del medio: lo arma el llamador porque cada uso mide otra cosa. */
  centro: { etiqueta: string; valor: string; nota?: string };
  /** Boton extra al principio del pie, como el play propio de la musica. */
  accion?: ReactNode;
  deshabilitado: boolean;
  onTrim: (patch: { trimIn?: number; trimOut?: number }) => void;
  onSeek: (segundos: number) => void;
}

/**
 * La barra de recorte: una sola linea de tiempo con la parte que queda
 * resaltada, las dos manijas y el cabezal.
 *
 * Reemplaza a tres deslizadores separados de posicion, entrada y salida, que no
 * dejaban ver que parte sobrevivia al corte. La usan el video y la musica: es el
 * mismo gesto en los dos, y siendo un solo componente no se pueden separar.
 *
 * La barra no dibuja siempre el material entero: apenas hay un corte marcado se
 * estira a ese pedazo (ver `vistaDeLaBarra`), asi el tramo que sobrevive ocupa
 * el ancho completo y se puede recorrer con el dedo. Eso es lo que reemplazo a
 * los botones de a un cuadro, que pedian mucho espacio para un ajuste que en el
 * telefono no se usaba.
 */
export function Recortador({
  duracion,
  trimIn,
  trimOut,
  currentTime,
  paso,
  centro,
  accion,
  deshabilitado,
  onTrim,
  onSeek,
}: RecortadorProps) {
  const agarre = useRef<Agarre | null>(null);
  /**
   * La vista se queda quieta mientras dura un arrastre. Sin esto la escala se
   * recalcularia en cada pixel y el punto que tenes abajo del dedo se correria
   * solo, que es la peor sensacion posible en una barra.
   */
  const [congelada, setCongelada] = useState<Vista | null>(null);
  /** El material entero, a pedido, para volver a abrir un corte ya hecho. */
  const [verTodo, setVerTodo] = useState(false);

  // Cambiar de clip empieza de cero: el corte del nuevo manda sobre lo que
  // hubiera pedido el anterior.
  useEffect(() => setVerTodo(false), [duracion]);

  const vista: Vista =
    congelada ??
    (verTodo ? { desde: 0, hasta: duracion } : vistaDeLaBarra(trimIn, trimOut, duracion));
  const estirada = vista.desde > 0 || vista.hasta < duracion;

  const fraccion = (segundos: number) => fraccionEnLaVista(segundos, vista);

  const moverEntrada = useCallback(
    (segundos: number) => {
      const valor = limitarEntrada(segundos, trimOut, paso);
      onTrim({ trimIn: valor });
      // El visor salta al cuadro que se esta marcando: es lo que reemplaza a las
      // miniaturas, sin tener que decodificar nada de mas.
      onSeek(valor);
    },
    [trimOut, paso, onTrim, onSeek],
  );

  const moverSalida = useCallback(
    (segundos: number) => {
      const valor = limitarSalida(segundos, trimIn, paso, duracion);
      onTrim({ trimOut: valor });
      onSeek(valor);
    },
    [trimIn, paso, duracion, onTrim, onSeek],
  );

  const aplicar = useCallback(
    (que: Agarre, clientX: number, rect: DOMRect, enVista: Vista) => {
      const segundos = segundosDesdeX(clientX, rect, enVista);
      if (que === 'entrada') moverEntrada(segundos);
      else if (que === 'salida') moverSalida(segundos);
      else onSeek(segundos);
    },
    [moverEntrada, moverSalida, onSeek],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (deshabilitado || duracion <= 0) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const aEntrada = Math.abs(x - fraccion(trimIn) * rect.width);
      const aSalida = Math.abs(x - fraccion(trimOut) * rect.width);

      // Si el toque cae cerca de una manija es esa manija (la mas cercana si
      // estan pegadas); si no, es el cabezal.
      const que: Agarre =
        Math.min(aEntrada, aSalida) <= TOLERANCIA_PX
          ? aEntrada <= aSalida
            ? 'entrada'
            : 'salida'
          : 'cabezal';

      agarre.current = que;
      setCongelada(vista);
      e.currentTarget.setPointerCapture(e.pointerId);
      aplicar(que, e.clientX, rect, vista);
    },
    [deshabilitado, duracion, trimIn, trimOut, vista, aplicar],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const que = agarre.current;
      if (!que) return;
      aplicar(que, e.clientX, e.currentTarget.getBoundingClientRect(), congelada ?? vista);
    },
    [aplicar, congelada, vista],
  );

  const soltar = useCallback(() => {
    const que = agarre.current;
    agarre.current = null;
    setCongelada(null);
    // Marcar una entrada o una salida redefine el corte, asi que la barra se
    // vuelve a estirar al pedazo nuevo. Mover el cabezal no: ese es el gesto de
    // mirar, y no tiene por que cambiar la escala abajo del dedo.
    if (que === 'entrada' || que === 'salida') setVerTodo(false);
  }, []);

  /** Las flechas del teclado siguen moviendo de a un paso exacto. */
  const teclas = (e: React.KeyboardEvent, mover: (pasos: number) => void) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      mover(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      mover(1);
    }
  };

  const pasosEntrada = (pasos: number) => moverEntrada(trimIn + pasos * paso);
  const pasosSalida = (pasos: number) => moverSalida(trimOut + pasos * paso);

  return (
    <div className="recortador">
      <div className="recortador-tiempos">
        <Marca etiqueta="entrada" valor={formatSeconds(trimIn)} />

        <div className="recortador-marca centrada">
          <span className="etiqueta">{centro.etiqueta}</span>
          <span className="recortador-valor">{centro.valor}</span>
          {centro.nota && <span className="recortador-nota">{centro.nota}</span>}
        </div>

        <Marca etiqueta="salida" valor={formatSeconds(trimOut)} />
      </div>

      <div
        className={`recortador-barra${deshabilitado ? ' apagada' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={soltar}
        onPointerCancel={soltar}
      >
        <div
          className="recortador-queda"
          style={{
            left: `${fraccion(trimIn) * 100}%`,
            right: `${(1 - fraccion(trimOut)) * 100}%`,
          }}
        />
        <div className="recortador-cabezal" style={{ left: `${fraccion(currentTime) * 100}%` }} />
        <div
          className="recortador-manija"
          role="slider"
          tabIndex={deshabilitado ? -1 : 0}
          aria-label="Entrada"
          aria-valuemin={0}
          aria-valuemax={duracion}
          aria-valuenow={trimIn}
          aria-valuetext={formatSeconds(trimIn)}
          onKeyDown={(e) => teclas(e, pasosEntrada)}
          style={{ left: `${fraccion(trimIn) * 100}%` }}
        />
        <div
          className="recortador-manija"
          role="slider"
          tabIndex={deshabilitado ? -1 : 0}
          aria-label="Salida"
          aria-valuemin={0}
          aria-valuemax={duracion}
          aria-valuenow={trimOut}
          aria-valuetext={formatSeconds(trimOut)}
          onKeyDown={(e) => teclas(e, pasosSalida)}
          style={{ left: `${fraccion(trimOut) * 100}%` }}
        />
      </div>

      <div className="recortador-pie">
        {accion}
        {estirada && (
          <button
            className="chico"
            disabled={deshabilitado}
            onClick={() => setVerTodo(true)}
            title="La barra esta estirada al corte: esto muestra el material entero para volver a abrirlo"
          >
            todo
          </button>
        )}
        <span className="recortador-posicion">
          {formatSeconds(currentTime)} / {formatSeconds(duracion)}
        </span>
      </div>
    </div>
  );
}

function Marca({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="recortador-marca">
      <span className="etiqueta">{etiqueta}</span>
      <span className="recortador-valor">{valor}</span>
    </div>
  );
}
