import { useCallback, useRef, type ReactNode } from 'react';

import { formatSeconds, limitarEntrada, limitarSalida, segundosDesdeX } from './trim';

/**
 * Cuanto puede errarle el dedo a una manija y agarrarla igual. Un toque mas
 * lejos que esto mueve el cabezal, que es lo que se quiere al tocar en el medio.
 */
const TOLERANCIA_PX = 22;

type Agarre = 'entrada' | 'salida' | 'cabezal';

/** Donde cae un segundo del clip dentro de la barra, de 0 a 1. */
function fraccionDe(segundos: number, duracion: number): number {
  return duracion > 0 ? Math.min(1, Math.max(0, segundos / duracion)) : 0;
}

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
  /** Como se lee ese paso en los botones: "Un cuadro", "Una decima". */
  nombrePaso: string;
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
 */
export function Recortador({
  duracion,
  trimIn,
  trimOut,
  currentTime,
  paso,
  nombrePaso,
  centro,
  accion,
  deshabilitado,
  onTrim,
  onSeek,
}: RecortadorProps) {
  const agarre = useRef<Agarre | null>(null);

  const fraccion = (segundos: number) => fraccionDe(segundos, duracion);

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
    (que: Agarre, clientX: number, rect: DOMRect) => {
      const segundos = segundosDesdeX(clientX, rect, duracion);
      if (que === 'entrada') moverEntrada(segundos);
      else if (que === 'salida') moverSalida(segundos);
      else onSeek(segundos);
    },
    [duracion, moverEntrada, moverSalida, onSeek],
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
      e.currentTarget.setPointerCapture(e.pointerId);
      aplicar(que, e.clientX, rect);
    },
    [deshabilitado, duracion, trimIn, trimOut, aplicar],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const que = agarre.current;
      if (!que) return;
      aplicar(que, e.clientX, e.currentTarget.getBoundingClientRect());
    },
    [aplicar],
  );

  const soltar = useCallback(() => {
    agarre.current = null;
  }, []);

  /** Las flechas del teclado mueven de a un paso, igual que los botones. */
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
        <Marca
          etiqueta="entrada"
          valor={formatSeconds(trimIn)}
          nombrePaso={nombrePaso}
          deshabilitado={deshabilitado}
          onPaso={pasosEntrada}
        />

        <div className="recortador-marca centrada">
          <span className="etiqueta">{centro.etiqueta}</span>
          <span className="recortador-valor">{centro.valor}</span>
          {centro.nota && <span className="recortador-nota">{centro.nota}</span>}
        </div>

        <Marca
          etiqueta="salida"
          valor={formatSeconds(trimOut)}
          nombrePaso={nombrePaso}
          deshabilitado={deshabilitado}
          onPaso={pasosSalida}
        />
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
        <button
          className="chico"
          disabled={deshabilitado}
          onClick={() => onTrim({ trimIn: limitarEntrada(currentTime, trimOut, paso) })}
        >
          entrada acá
        </button>
        <button
          className="chico"
          disabled={deshabilitado}
          onClick={() => onTrim({ trimOut: limitarSalida(currentTime, trimIn, paso, duracion) })}
        >
          salida acá
        </button>
        <span className="recortador-posicion">
          {formatSeconds(currentTime)} / {formatSeconds(duracion)}
        </span>
      </div>
    </div>
  );
}

function Marca({
  etiqueta,
  valor,
  nombrePaso,
  deshabilitado,
  onPaso,
}: {
  etiqueta: string;
  valor: string;
  nombrePaso: string;
  deshabilitado: boolean;
  onPaso: (pasos: number) => void;
}) {
  return (
    <div className="recortador-marca">
      <span className="etiqueta">{etiqueta}</span>
      <span className="recortador-valor">{valor}</span>
      <div className="recortador-cuadros">
        <button
          disabled={deshabilitado}
          onClick={() => onPaso(-1)}
          title={`${nombrePaso} atrás en ${etiqueta.toLowerCase()}`}
        >
          ◀
        </button>
        <button
          disabled={deshabilitado}
          onClick={() => onPaso(1)}
          title={`${nombrePaso} adelante en ${etiqueta.toLowerCase()}`}
        >
          ▶
        </button>
      </div>
    </div>
  );
}
