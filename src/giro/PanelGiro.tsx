/**
 * La estabilizacion por giroscopio, de la lectura del archivo a los controles.
 *
 * Este panel es duenio de todo el camino: lee el giroscopio del clip, arma la
 * correccion con los parametros que el usuario mueve, y se la entrega al visor
 * por `onEstabilizacion`. El visor no sabe nada de giroscopios: recibe una
 * matriz por cuadro y la aplica.
 *
 * Sigue mostrando el diagnostico de la lectura -frecuencia, cuanto abarca, los
 * ejes declarados, las curvas- porque es lo que permite distinguir "esto se ve
 * mal" de "esto se leyo mal", que son dos problemas muy distintos.
 */

import { useEffect, useMemo, useState } from 'react';

import type { TimelineClip } from '../edit/types';
import { Deslizador } from '../ui/Deslizador';
import { Curvas } from './Curvas';
import {
  mapeoDesdeOrientacion,
  prepararEstabilizacion,
  MAPEO_GOPRO,
  MAPEO_SONY,
  type Estabilizacion,
} from './estabilizar';
import { hayGiro, leerGiroscopio } from './leer';
import { focalPxDesdeMm, type DatosGiro, type SinGiro } from './tipos';

interface Props {
  clip: TimelineClip | null;
  /** El cabezal, para marcarlo sobre las curvas. En segundos del clip. */
  cabezal: number;
  /** Le pasa al visor la correccion vigente, o null para no estabilizar. */
  onEstabilizacion: (estabilizacion: Estabilizacion | null) => void;
}

/**
 * Cuantos momentos del clip se miran para decidir el recorte.
 *
 * El recorte lo manda el peor instante del clip, y ese instante dura bastante
 * mas que un cuadro: mirar doscientos repartidos parejo lo encuentra igual que
 * mirarlos todos, y cuesta una fraccion.
 */
const MUESTRAS_DE_RECORTE = 200;

/** El campo horizontal por defecto cuando la camara no dice cual es. */
const FOV_POR_DEFECTO = 120;

export function PanelGiro({ clip, cabezal, onEstabilizacion }: Props) {
  const [resultado, setResultado] = useState<DatosGiro | SinGiro | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [tardo, setTardo] = useState(0);
  /** De que clip son los datos que hay en pantalla. */
  const [deQuien, setDeQuien] = useState<string | null>(null);

  const [activo, setActivo] = useState(false);
  /** Cuantos segundos de movimiento se promedian para sacar el temblor. */
  const [suavidad, setSuavidad] = useState(0.5);
  /** Cuanto se corre el giroscopio respecto del video, en milisegundos. */
  const [desfaseMs, setDesfaseMs] = useState(0);
  /**
   * Los milimetros que puso el usuario a mano.
   *
   * Hace falta con un lente manual: sin contactos electricos, la camara no sabe
   * que lente tiene puesto y no escribe la focal. El ancho del sensor si lo
   * escribe, asi que con el numero del barril del lente alcanza.
   */
  const [mmAMano, setMmAMano] = useState('');
  /**
   * El campo de vision a ojo, para cuando no hay NI focal NI sensor.
   *
   * Es el caso de las GoPro que no escriben su calibracion. Sin este numero no
   * se puede saber cuantos pixeles mover por cada grado que giro la camara, y
   * es preferible una perilla honesta que un valor inventado.
   */
  const [fovAMano, setFovAMano] = useState(FOV_POR_DEFECTO);
  /**
   * Cuanto encuadre se acepta perder, como maximo.
   *
   * Sin tope el recorte lo decide el peor instante del clip: apoyar la camara
   * al final le impone su zoom a todo lo anterior. Con tope, ese instante se
   * corrige solo hasta donde entra.
   */
  const [recorteMax, setRecorteMax] = useState(15);

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
  const datos = vigente && hayGiro(vigente) ? vigente : null;
  const optica = datos?.optica ?? null;

  /**
   * La focal que se va a usar, por orden de confianza: la que puso el usuario
   * en milimetros, la que declaro la camara, y por ultimo el campo de vision a
   * ojo. Lo escrito a mano gana para poder corregir un lente adaptado que
   * declara los milimetros del adaptador y no los suyos.
   */
  const focalPx = useMemo(() => {
    const ancho = clip?.info.displayWidth ?? 0;
    if (mmAMano && optica?.sensorAnchoMm) {
      const calculada = focalPxDesdeMm(Number(mmAMano), optica.sensorAnchoMm, optica.anchoPx);
      if (calculada) return calculada;
    }
    if (optica?.focalPx) return optica.focalPx;
    if (ancho > 0) {
      // De campo horizontal a focal: media imagen sobre la tangente de medio
      // campo. Es la relacion del agujero de alfiler.
      return ancho / 2 / Math.tan((fovAMano * Math.PI) / 360);
    }
    return null;
  }, [mmAMano, optica, fovAMano, clip?.info.displayWidth]);

  /** De donde salio la focal, para decirlo en pantalla sin que sea un misterio. */
  const origenFocal =
    mmAMano && optica?.sensorAnchoMm
      ? 'a mano'
      : optica?.focalPx
        ? 'de la cámara'
        : 'del campo a ojo';

  const estabilizacion = useMemo<Estabilizacion | null>(() => {
    if (!activo || !datos || !clip || !focalPx) return null;

    // Los ejes salen del archivo cuando la camara los declara; si no, del mapeo
    // tipico de esa marca, que ya es una suposicion.
    const mapeo =
      (datos.orientacionEjes ? mapeoDesdeOrientacion(datos.orientacionEjes) : null) ??
      (datos.fuente === 'sony' ? MAPEO_SONY : MAPEO_GOPRO);

    // Solo el tramo que quedo despues de recortar: un golpe en un pedazo que
    // el usuario ya descarto no tiene por que costarle encuadre al resto.
    const desde = clip.trimIn;
    const hasta = clip.trimOut > clip.trimIn ? clip.trimOut : clip.info.durationSeconds || 1;
    const cuadros = Array.from(
      { length: MUESTRAS_DE_RECORTE },
      (_, i) => desde + ((hasta - desde) * i) / (MUESTRAS_DE_RECORTE - 1),
    );

    return prepararEstabilizacion(datos.muestras, cuadros, {
      suavidad,
      desfase: desfaseMs / 1000,
      focalPx,
      ancho: clip.info.displayWidth,
      alto: clip.info.displayHeight,
      mapeo,
      zoomMaximo: 1 + recorteMax / 100,
    });
  }, [activo, datos, clip, focalPx, suavidad, desfaseMs, recorteMax]);

  // El visor no guarda estado del giroscopio: recibe la correccion ya armada.
  useEffect(() => {
    onEstabilizacion(estabilizacion);
  }, [estabilizacion, onEstabilizacion]);

  // Al desmontar hay que apagarla: la correccion del clip anterior no tiene
  // nada que ver con el siguiente.
  useEffect(() => () => onEstabilizacion(null), [onEstabilizacion]);

  const recorte = estabilizacion ? ((estabilizacion.zoom - 1) * 100).toFixed(0) : '0';
  const ideal = estabilizacion ? ((estabilizacion.zoomIdeal - 1) * 100).toFixed(0) : '0';

  return (
    <section className="panel">
      <div className="fila">
        <span className="comentario">giroscopio</span>
        <span className="etiqueta">{datos?.modelo ?? (clip ? clip.info.name : 'sin clip')}</span>
      </div>

      <button className="chico" disabled={!clip || leyendo} onClick={() => void leer()}>
        {leyendo ? 'leyendo…' : datos ? 'volver a leer' : 'leer el giroscopio de este clip'}
      </button>

      {vigente && !hayGiro(vigente) && (
        <>
          <p className="aviso">{vigente.motivo}</p>
          {vigente.pistas.length > 0 && (
            <p className="nota">/* pistas encontradas: {vigente.pistas.join(', ')} */</p>
          )}
        </>
      )}

      {datos && (
        <>
          <label className="fila">
            <input
              type="checkbox"
              checked={activo}
              disabled={!focalPx}
              onChange={(e) => setActivo(e.target.checked)}
            />
            <span className="comentario">estabilizar este clip</span>
          </label>

          {activo && estabilizacion && (
            <>
              <Deslizador
                etiqueta="suavidad"
                valor={suavidad}
                min={0.05}
                max={2}
                paso={0.05}
                onChange={setSuavidad}
                texto={`${suavidad.toFixed(2)}s`}
              />
              <Deslizador
                etiqueta="desfase"
                valor={desfaseMs}
                min={-200}
                max={200}
                paso={5}
                onChange={setDesfaseMs}
                texto={`${desfaseMs > 0 ? '+' : ''}${desfaseMs}ms`}
              />
              {!optica?.focalPx && (
                <Deslizador
                  etiqueta="campo horizontal"
                  valor={fovAMano}
                  min={40}
                  max={160}
                  paso={1}
                  onChange={setFovAMano}
                  texto={`${fovAMano}°`}
                />
              )}
              <Deslizador
                etiqueta="recorte máximo"
                valor={recorteMax}
                min={0}
                max={50}
                paso={1}
                onChange={setRecorteMax}
                texto={`${recorteMax}%`}
              />
              <p className="nota">
                /* recorte {recorte}% · corrige hasta{' '}
                {estabilizacion.correccionMaxGrados.toFixed(1)}° · focal {origenFocal} */
              </p>
              {estabilizacion.zoomIdeal > estabilizacion.zoom + 0.005 && (
                <p className="aviso">
                  Para corregir todo harían falta {ideal}% de recorte. Los momentos más bruscos se
                  corrigen a medias para no comerse el encuadre del resto del clip.
                </p>
              )}
            </>
          )}

          <ul className="faltantes">
            <li className="hay">
              <span className="marca">✓</span>
              <span className="nombre">
                {datos.fuente} · {datos.formato}
              </span>
              <span className="detalle">{datos.muestras.length} mediciones</span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">frecuencia medida</span>
              <span className="detalle">{datos.hz.toFixed(0)} Hz</span>
            </li>
            <li className="hay">
              <span className="marca">·</span>
              <span className="nombre">abarca</span>
              <span className="detalle">
                {datos.duracionSeconds.toFixed(2)}s de {clip?.info.durationSeconds.toFixed(2)}s
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
                {focalPx ? `f=${focalPx.toFixed(0)}px · ${origenFocal}` : 'falta'}
              </span>
            </li>
            <li className="hay">
              <span className="marca">{datos.orientacionEjes ? '✓' : '·'}</span>
              <span className="nombre">ejes declarados</span>
              <span className="detalle">{datos.orientacionEjes ?? 'hay que adivinarlos'}</span>
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
          {!optica && datos.claves.length > 0 && (
            <p className="nota">/* claves del archivo: {datos.claves.join(' ')} */</p>
          )}

          <Curvas muestras={datos.muestras} cabezal={cabezal} />

          <small>
            Rojo, verde y azul son los tres ejes. Con la cámara quieta tienen que ser tres líneas
            planas; un paneo tiene que levantar un eje solo.
            {!optica?.focalPx &&
              ' Esta cámara no dice su campo de visión: si la corrección se queda corta subí el campo horizontal, y si se pasa, bajalo.'}
          </small>
        </>
      )}
    </section>
  );
}
