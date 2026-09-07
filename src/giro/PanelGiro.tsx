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
import { focalPxDesdeMm, type DatosGiro, type SinGiro } from './tipos';

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
  /**
   * Los milimetros que puso el usuario a mano.
   *
   * Hace falta con un lente manual: sin contactos electricos, la camara no
   * sabe que lente tiene puesto y no escribe la focal. El ancho del sensor si
   * lo escribe, asi que con el numero del barril del lente alcanza.
   */
  const [mmAMano, setMmAMano] = useState('');

  const leer = async () => {
    if (!clip) return;
    setLeyendo(true);
    const arranque = performance.now();
    const r = await leerGiroscopio(clip.file, clip.info.displayWidth);
    setTardo(performance.now() - arranque);
    setResultado(r);
    setDeQuien(clip.id);
    setLeyendo(false);
  };

  const vigente = deQuien === clip?.id ? resultado : null;
  const optica = vigente && hayGiro(vigente) ? vigente.optica : null;
  /**
   * La focal que se va a usar: la que declaro el lente, o la que puso el
   * usuario. Lo escrito a mano gana, para poder corregir un lente adaptado que
   * declara los milimetros del adaptador y no los suyos.
   */
  const focalPx =
    (mmAMano && optica?.sensorAnchoMm
      ? focalPxDesdeMm(Number(mmAMano), optica.sensorAnchoMm, optica.anchoPx)
      : null) ?? optica?.focalPx ?? null;

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
              <span className="nombre">{optica?.radial ? 'lente calibrado' : 'sensor leído'}</span>
              <span className="detalle">
                {optica?.radial
                  ? `${optica.radial.modo || 'sin modo'} · ${
                      optica.radial.anguloMaxRad
                        ? `${((optica.radial.anguloMaxRad * 360) / Math.PI).toFixed(0)}° diag`
                        : 'sin campo'
                    }`
                  : optica?.sensorAnchoMm
                    ? `${optica.sensorAnchoMm.toFixed(1)} mm de ancho`
                    : 'no lo escribió'}
              </span>
            </li>
            <li className="hay">
              <span className="marca">{focalPx ? '✓' : '·'}</span>
              <span className="nombre">focal</span>
              <span className="detalle">
                {!focalPx
                  ? 'falta'
                  : optica?.radial
                    ? `f=${focalPx.toFixed(0)}px · de la calibración`
                    : `${(optica?.focalMm ?? Number(mmAMano)).toFixed(0)}mm · f=${focalPx.toFixed(0)}px`}
              </span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">tardó</span>
              <span className="detalle">{tardo.toFixed(0)} ms</span>
            </li>
          </ul>

          {optica?.sensorAnchoMm && !optica.radial && (
            <div className="fila nombrar">
              <span className="comentario">
                {optica.focalMm === null ? 'lente manual · mm' : 'forzar mm'}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                max={2000}
                step={1}
                value={mmAMano}
                placeholder={optica.focalMm?.toFixed(0) ?? '35'}
                onChange={(e) => setMmAMano(e.target.value)}
              />
            </div>
          )}

          {/* Cuando falta la calibracion, lo importante es saber que SI trae el
              archivo: distingue un error de lectura de una camara que no la
              escribe. */}
          {!optica && vigente.claves.length > 0 && (
            <p className="nota">/* claves del archivo: {vigente.claves.join(' ')} */</p>
          )}

          <Curvas muestras={vigente.muestras} cabezal={cabezal} />

          <small>
            Rojo, verde y azul son los tres ejes. Con la cámara quieta tienen que ser tres líneas
            planas; un paneo tiene que levantar un eje solo. El pico en °/s de arriba a la izquierda
            dice si las unidades están bien: a mano difícilmente pase de 200.
            {optica?.radial
              ? ' Esta GoPro trae su calibración de fábrica adentro del archivo, así que la focal y la curvatura del ojo de pez salen solas.'
              : optica?.focalMm === null
                ? ' Con un lente manual la cámara no sabe la focal: poné los mm que dice el barril.'
                : ''}
          </small>
        </>
      )}
    </section>
  );
}
