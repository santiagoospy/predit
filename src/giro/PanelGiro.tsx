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

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TimelineClip } from '../edit/types';
import { Deslizador } from '../ui/Deslizador';
import { AJUSTES_POR_DEFECTO, type AjustesGiro } from './ajustes';
import { Curvas } from './Curvas';
import {
  cadenaComoGyroflow,
  mapeoDesdeOrientacion,
  prepararEstabilizacion,
  MAPEO_GOPRO,
  MAPEO_SONY,
  estabilizacionFija,
  type Estabilizacion,
} from './estabilizar';
import { hayGiro, leerGiroscopio } from './leer';
import { perfilPara } from './lente';
import { focalPxDesdeMm, type DatosGiro, type SinGiro } from './tipos';

interface Props {
  clip: TimelineClip | null;
  /** El cabezal, para marcarlo sobre las curvas. En segundos del clip. */
  cabezal: number;
  /**
   * Le pasa al visor la correccion vigente, o null para no estabilizar. El id
   * del clip va aparte porque el export monta varios y tiene que saber a cual
   * corresponde.
   */
  onEstabilizacion: (estabilizacion: Estabilizacion | null, clipId: string | null) => void;
  /**
   * Cambia un ajuste del clip abierto. Los ajustes no viven aca sino en el
   * clip (`TimelineClip.giro`): es lo que hace que se guarden con el proyecto
   * y que pasar a otro clip y volver no los pierda.
   */
  onAjustes: (parcial: Partial<AjustesGiro>) => void;
}

/**
 * Cuantos momentos del clip se miran para decidir el recorte.
 *
 * El recorte lo manda el peor instante del clip, y ese instante dura bastante
 * mas que un cuadro: mirar doscientos repartidos parejo lo encuentra igual que
 * mirarlos todos, y cuesta una fraccion.
 */
const MUESTRAS_DE_RECORTE = 200;

/**
 * A partir de que velocidad angular (grados por segundo) el suavizado empieza
 * a ceder para seguir un paneo. Ver suavizar(). Medido offline sobre un clip
 * real: con 15 la ganancia se mantiene en 1 durante un giro de 170 grados y
 * el balanceo lento se sigue corrigiendo.
 */
const VELOCIDAD_DE_PANEO = 15;

/** Una lectura del giroscopio ya hecha, guardada para no repetirla. */
interface Lectura {
  resultado: DatosGiro | SinGiro;
  /** Milisegundos que costo leerla, para el diagnostico. */
  tardo: number;
}

/**
 * Con que se reconoce el ARCHIVO de un clip.
 *
 * La lectura se guarda por archivo y no por clip a proposito: cortar un video
 * en tres da tres clips con id propio pero un solo archivo, y leer el mismo
 * giroscopio tres veces son varios segundos regalados. Los ajustes, en cambio,
 * van por clip: cada pedazo puede querer su propia suavidad.
 */
function claveDeArchivo(clip: TimelineClip): string {
  return `${clip.file.name}|${clip.file.size}|${clip.file.lastModified}`;
}

export function PanelGiro({ clip, cabezal, onEstabilizacion, onAjustes }: Props) {
  /** Lo leido de cada archivo. Sobrevive a cambiar de clip y a volver. */
  const [lecturas, setLecturas] = useState<Map<string, Lectura>>(() => new Map());
  const [leyendo, setLeyendo] = useState(false);

  const ajustes = clip?.giro ?? AJUSTES_POR_DEFECTO;
  const {
    activo,
    suavidad,
    desfaseMs,
    mmAMano,
    fovAMano,
    recorteMax,
    ejesAMano,
    giroDePrueba,
    corregirLente,
    rectificar,
    obturador,
  } = ajustes;

  const lectura = clip ? lecturas.get(claveDeArchivo(clip)) ?? null : null;
  const tardo = lectura?.tardo ?? 0;

  const leer = useCallback(async () => {
    if (!clip) return;
    const clave = claveDeArchivo(clip);
    setLeyendo(true);
    const arranque = performance.now();
    const r = await leerGiroscopio(clip.file, clip.info.displayWidth);
    const cuanto = performance.now() - arranque;
    setLecturas((previas) => new Map(previas).set(clave, { resultado: r, tardo: cuanto }));
    setLeyendo(false);
  }, [clip]);

  const vigente = lectura?.resultado ?? null;

  /*
   * Un clip que quedo guardado como estabilizado se lee solo al abrirlo.
   *
   * Al reabrir un proyecto vuelven los ajustes pero no las mediciones -esas se
   * releen del archivo-, asi que sin esto la casilla figuraria tildada y la
   * imagen saldria sin corregir hasta apretar el boton. Solo pasa con los clips
   * que el usuario ya habia estabilizado, y una sola vez por archivo: el
   * resultado queda en `lecturas`, y hasta el "no tiene giroscopio" se guarda,
   * asi que un archivo sin datos no se reintenta en loop.
   */
  useEffect(() => {
    if (!clip || !clip.giro.activo || lectura || leyendo) return;
    void leer();
  }, [clip, lectura, leyendo, leer]);
  const datos = vigente && hayGiro(vigente) ? vigente : null;
  const optica = datos?.optica ?? null;

  /** El perfil del lente para este clip, escalado a su resolucion, si hay. */
  const perfil = useMemo(
    () => (datos && clip ? perfilPara(datos.fuente, clip.info.displayWidth, clip.info.displayHeight) : null),
    [datos, clip],
  );
  const lente = corregirLente ? perfil : null;

  /**
   * La focal que se va a usar, por orden de confianza: la que puso el usuario
   * en milimetros, la que declaro la camara, y por ultimo el campo de vision a
   * ojo. Lo escrito a mano gana para poder corregir un lente adaptado que
   * declara los milimetros del adaptador y no los suyos.
   */
  const focalPx = useMemo(() => {
    const ancho = clip?.info.displayWidth ?? 0;
    // Con perfil de lente la focal es la del perfil: es la que deja el centro
    // de la imagen a la misma escala que el original.
    if (lente) return lente.fx;
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
  }, [lente, mmAMano, optica, fovAMano, clip?.info.displayWidth]);

  /** De donde salio la focal, para decirlo en pantalla sin que sea un misterio. */
  const origenFocal = lente
    ? 'del perfil'
    : mmAMano && optica?.sensorAnchoMm
      ? 'a mano'
      : optica?.focalPx
        ? 'de la cámara'
        : 'del campo a ojo';

  const estabilizacion = useMemo<Estabilizacion | null>(() => {
    if (!activo || !datos || !clip || !focalPx) return null;

    if (giroDePrueba !== 0) {
      return estabilizacionFija(
        { pitch: 0, yaw: giroDePrueba, roll: 0 },
        { focalPx, ancho: clip.info.displayWidth, alto: clip.info.displayHeight, lente, rectificar },
      );
    }

    // Lo escrito a mano manda; si no, lo que declaro la camara; y si tampoco,
    // "XYZ", que es lo que asume Gyroflow. Todo se lee con la convencion de
    // Gyroflow (ver mapeoDesdeOrientacion).
    const codigo = ejesAMano.trim() || datos.orientacionEjes || '';
    const mapeo =
      mapeoDesdeOrientacion(codigo, datos.fuente) ??
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
      velocidadDeReferencia: VELOCIDAD_DE_PANEO,
      zoomMaximo: 1 + recorteMax / 100,
      lente,
      rectificar,
      // Lo que la camara dice de sus tiempos, si lo dice. El deslizador de
      // desfase queda como ajuste fino alrededor de esto.
      retardoDelCuadro: datos.tiempos?.retardoDelCuadro ?? 0,
      tiempoDeLectura: obturador ? datos.tiempos?.tiempoDeLectura ?? 0 : 0,
    });
  }, [activo, datos, clip, focalPx, suavidad, desfaseMs, recorteMax, ejesAMano, giroDePrueba, lente, rectificar, obturador]);

  // El visor no guarda estado del giroscopio: recibe la correccion ya armada.
  useEffect(() => {
    onEstabilizacion(estabilizacion, clip?.id ?? null);
  }, [estabilizacion, onEstabilizacion, clip?.id]);

  /*
   * A proposito NO se apaga al desmontar.
   *
   * Este panel solo existe en la pestana "clip", asi que apagar al desmontar
   * significaba perder la correccion al ir a "salida" a exportar: el export
   * salia sin estabilizar, que es justo cuando mas importa.
   *
   * Lo que evita aplicarle la correccion de un clip a otro no es apagarla, es
   * el `clipId` que va con ella: el visor y el export solo la usan si coincide
   * con el clip que estan dibujando. Cambiar de clip aca ya recalcula y avisa
   * con el id nuevo, y destildar la casilla manda null.
   *
   * Lo que si queda pendiente: si se cambia el recorte del clip desde otra
   * pestana, la correccion queda calculada con el rango viejo hasta volver
   * aca. Se arregla solo cuando los ajustes vivan en ClipDoc.
   */

  const recorte = estabilizacion ? ((estabilizacion.zoom - 1) * 100).toFixed(0) : '0';
  const ideal = estabilizacion ? ((estabilizacion.zoomIdeal - 1) * 100).toFixed(0) : '0';
  /** La correccion que se esta aplicando en el cabezal, para verla moverse. */
  const ahora = estabilizacion?.correccionEn(cabezal) ?? null;
  const gananciaAhora = estabilizacion?.gananciaEn(cabezal) ?? 1;

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
              onChange={(e) => onAjustes({ activo: e.target.checked })}
            />
            <span className="comentario">estabilizar este clip</span>
          </label>

          {activo && estabilizacion && (
            <>
              <Deslizador
                etiqueta="suavidad"
                valor={suavidad}
                min={0.02}
                max={4}
                paso={0.05}
                onChange={(v) => onAjustes({ suavidad: v })}
                texto={`${suavidad.toFixed(2)}s`}
              />
              <Deslizador
                etiqueta="desfase"
                valor={desfaseMs}
                min={-200}
                max={200}
                paso={5}
                onChange={(v) => onAjustes({ desfaseMs: v })}
                texto={`${desfaseMs > 0 ? '+' : ''}${desfaseMs}ms`}
              />
              {perfil && (
                <>
                  <label className="fila">
                    <input
                      type="checkbox"
                      checked={corregirLente}
                      onChange={(e) => onAjustes({ corregirLente: e.target.checked })}
                    />
                    <span className="comentario">corregir el lente (ojo de pez)</span>
                  </label>
                  {corregirLente && (
                    <label className="fila">
                      <input
                        type="checkbox"
                        checked={rectificar}
                        onChange={(e) => onAjustes({ rectificar: e.target.checked })}
                      />
                      <span className="comentario">enderezar (rectas rectas, recorta ~30%)</span>
                    </label>
                  )}
                </>
              )}
              {datos.tiempos && datos.tiempos.tiempoDeLectura > 0 && (
                <label className="fila">
                  <input
                    type="checkbox"
                    checked={obturador}
                    onChange={(e) => onAjustes({ obturador: e.target.checked })}
                  />
                  <span className="comentario">
                    corregir el obturador rodante ({(datos.tiempos.tiempoDeLectura * 1000).toFixed(1)} ms)
                  </span>
                </label>
              )}
              {!optica?.focalPx && !lente && (
                <Deslizador
                  etiqueta="campo horizontal"
                  valor={fovAMano}
                  min={40}
                  max={160}
                  paso={1}
                  onChange={(v) => onAjustes({ fovAMano: v })}
                  texto={`${fovAMano}°`}
                />
              )}
              <Deslizador
                etiqueta="recorte máximo"
                valor={recorteMax}
                min={0}
                max={60}
                paso={1}
                onChange={(v) => onAjustes({ recorteMax: v })}
                texto={`${recorteMax}%`}
              />
              <div className="fila nombrar">
                <span className="comentario">ejes</span>
                <input
                  type="text"
                  maxLength={3}
                  spellCheck={false}
                  value={ejesAMano}
                  placeholder={datos.orientacionEjes ?? 'XYZ'}
                  onChange={(e) => onAjustes({ ejesAMano: e.target.value })}
                />
              </div>
              <small>
                Se leen como Gyroflow. Si tiembla el doble en todo, pasá las tres letras a
                minúscula. Si en vez de estabilizar inclina la imagen, intercambiá dos letras. Si
                un solo eje corrige al revés, poné esa letra en minúscula.
              </small>

              <Deslizador
                etiqueta="prueba: girar"
                valor={giroDePrueba}
                min={-10}
                max={10}
                paso={0.5}
                onChange={(v) => onAjustes({ giroDePrueba: v })}
                texto={giroDePrueba === 0 ? 'apagado' : `${giroDePrueba}° yaw`}
              />
              {giroDePrueba !== 0 && (
                <p className="aviso">
                  Prueba activa: la imagen tiene que estar corrida {giroDePrueba}° en horizontal.
                  Si no se movió, la corrección no está llegando al visor. Volvé a 0 para
                  estabilizar de verdad.
                </p>
              )}

              <p className="nota">
                /* recorte {recorte}% · corrige hasta{' '}
                {estabilizacion.correccionMaxGrados.toFixed(1)}° · entero en el{' '}
                {(estabilizacion.fraccionCompleta * 100).toFixed(0)}% del clip · focal{' '}
                {origenFocal} */
              </p>
              {ahora && (
                <p className="nota">
                  /* ahora: pitch {ahora.pitch.toFixed(2)}° · yaw {ahora.yaw.toFixed(2)}° · roll{' '}
                  {ahora.roll.toFixed(2)}° · ganancia {(gananciaAhora * 100).toFixed(0)}% */
                </p>
              )}
              {estabilizacion.gananciaMinima < 0.995 && (
                <p className="aviso">
                  Hay golpes que piden hasta {ideal}% de recorte y el tope está en {recorteMax}%.
                  Ahí la corrección baja hasta el{' '}
                  {(estabilizacion.gananciaMinima * 100).toFixed(0)}%; el resto del clip se corrige
                  entero. Si el golpe está al final, recortá el clip antes de él.
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
              <span className="marca">{perfil ? '✓' : '·'}</span>
              <span className="nombre">perfil de lente</span>
              <span className="detalle">{perfil ? perfil.nombre : 'ninguno para este formato'}</span>
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
              <span className="detalle">
                {datos.orientacionEjes
                  ? cadenaComoGyroflow(datos.orientacionEjes, datos.fuente) === datos.orientacionEjes
                    ? datos.orientacionEjes
                    : `${datos.orientacionEjes} · ${cadenaComoGyroflow(datos.orientacionEjes, datos.fuente)} como Gyroflow`
                  : 'no los declara · XYZ como Gyroflow'}
              </span>
            </li>
            <li className="hay">
              <span className="marca">{datos.tiempos ? '✓' : '·'}</span>
              <span className="nombre">tiempos del cuadro</span>
              <span className="detalle">
                {datos.tiempos
                  ? `retardo ${(datos.tiempos.retardoDelCuadro * 1000).toFixed(0)} ms · lectura ${(datos.tiempos.tiempoDeLectura * 1000).toFixed(1)} ms`
                  : 'no los escribe · el desfase va a mano'}
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
                onChange={(e) => onAjustes({ mmAMano: e.target.value })}
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
