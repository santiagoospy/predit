/**
 * El panel del spike: leer el giroscopio del clip seleccionado y mostrarlo.
 *
 * No estabiliza nada todavia. Esta para contestar las preguntas caras antes de
 * escribir la estabilizacion: si el parseo funciona con archivos de verdad, si
 * los tiempos dan, y cuanto tarda en el telefono. Todo lo que muestra es
 * diagnostico: la frecuencia medida, el pico y las curvas.
 */

import { useState } from 'react';

import type { TimelineClip } from '../edit/types';
import { Curvas } from './Curvas';
import { hayGiro, leerGiroscopio } from './leer';
import type { DatosGiro, SinGiro } from './tipos';

interface Props {
  clip: TimelineClip | null;
  /** El cabezal, para marcarlo sobre las curvas. En segundos del clip. */
  cabezal: number;
}

export function PanelGiro({ clip, cabezal }: Props) {
  const [resultado, setResultado] = useState<DatosGiro | SinGiro | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [tardo, setTardo] = useState(0);
  /** De que clip son los datos que hay en pantalla. */
  const [deQuien, setDeQuien] = useState<string | null>(null);

  const leer = async () => {
    if (!clip) return;
    setLeyendo(true);
    const arranque = performance.now();
    const r = await leerGiroscopio(clip.file);
    setTardo(performance.now() - arranque);
    setResultado(r);
    setDeQuien(clip.id);
    setLeyendo(false);
  };

  const vigente = deQuien === clip?.id ? resultado : null;

  return (
    <section className="panel">
      <div className="fila">
        <span className="comentario">giroscopio</span>
        <span className="etiqueta">{clip ? clip.info.name : 'sin clip'}</span>
      </div>

      <p className="nota">
        /* prueba de lectura: todavía no estabiliza, solo muestra si los datos están */
      </p>

      <button className="chico" disabled={!clip || leyendo} onClick={() => void leer()}>
        {leyendo ? 'leyendo…' : 'leer el giroscopio de este clip'}
      </button>

      {vigente && !hayGiro(vigente) && (
        <>
          <p className="aviso">{vigente.motivo}</p>
          {vigente.pistas.length > 0 && (
            <p className="nota">/* pistas encontradas: {vigente.pistas.join(', ')} */</p>
          )}
        </>
      )}

      {vigente && hayGiro(vigente) && (
        <>
          <ul className="faltantes">
            <li className="hay">
              <span className="marca">✓</span>
              <span className="nombre">
                {vigente.fuente} · {vigente.formato}
              </span>
              <span className="detalle">{vigente.muestras.length} mediciones</span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">frecuencia medida</span>
              <span className="detalle">{vigente.hz.toFixed(0)} Hz</span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">abarca</span>
              <span className="detalle">
                {vigente.duracionSeconds.toFixed(2)}s de {clip?.info.durationSeconds.toFixed(2)}s
              </span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">tardó</span>
              <span className="detalle">{tardo.toFixed(0)} ms</span>
            </li>
          </ul>

          <Curvas muestras={vigente.muestras} cabezal={cabezal} />

          <small>
            Rojo, verde y azul son los tres ejes. Con la cámara quieta tienen que ser tres líneas
            planas; un paneo tiene que levantar un eje solo. El pico en °/s de arriba a la izquierda
            dice si las unidades están bien: a mano difícilmente pase de 200.
          </small>
        </>
      )}
    </section>
  );
}
