import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { decodeAudioRange } from './audio/decode';
import { clipAportaAudio } from './audio/mix';
import { parseCube } from './color/cube';
import { esNeutro, GRADE_NEUTRO, LIMITES } from './color/grade';
import { computeFit, LutRenderer, type Framing } from './color/renderer';
import { BarraLinea } from './edit/BarraLinea';
import { partir } from './edit/cortar';
import { moverEnLista } from './edit/orden';
import { Recortador } from './edit/Recortador';
import { TiraClips } from './edit/TiraClips';
import { unCuadro } from './edit/trim';
import {
  capaEnSegundo,
  capaVisibleEn,
  clipOutputDuration,
  framingDeCapa,
  nextId,
  tiempoEnLaLinea,
  type LibraryLut,
  type MusicTrack,
  type OverlayLayer,
  type TimelineClip,
} from './edit/types';
import { cargarImagen } from './media/imagen';
import {
  clipWarnings,
  formatBytes,
  formatDuration,
  probeClip,
  type ClipInfo,
} from './media/probe';
import {
  deliverExport,
  exportClips,
  type ExportClip,
  type ExportProgress,
} from './export/exporter';
import {
  conformSpeed,
  DEFAULT_FRAME_RATE,
  DEFAULT_PRESET,
  EXPORT_PRESETS,
  type ExportPreset,
} from './export/presets';
import { AJUSTES_POR_DEFECTO, type AjustesGiro } from './giro/ajustes';
import type { Estabilizacion } from './giro/estabilizar';
import { PanelGiro } from './giro/PanelGiro';
import { Deslizador } from './ui/Deslizador';
import { guardarLut, guardarMedio } from './proyecto/almacen';
import { huellaDe } from './proyecto/esquema';
import { PanelProyecto } from './proyecto/PanelProyecto';
import { ReVincular } from './proyecto/ReVincular';
import type { EstadoRestaurado } from './proyecto/restaurar';
import { useProyecto } from './proyecto/useProyecto';

/** El preview no necesita mas de esto; ahorra bateria y memoria en el telefono. */
const PREVIEW_MAX_SIDE = 1280;

/**
 * El ajuste fino de la barra de musica. Un video se corta al cuadro; un tema no
 * tiene cuadros, y la decima es lo mas chico que el oido distingue en un corte.
 */
const PASO_MUSICA = 0.1;

/**
 * Hasta donde se puede correr una capa, en semiejes del lienzo. Un poco mas de
 * 1 para poder sacarla apenas del cuadro, pero no tanto como para perderla.
 */
const TOPE_CAPA = 1.5;

function limitarOffset(valor: number): number {
  return Math.min(TOPE_CAPA, Math.max(-TOPE_CAPA, valor));
}

/**
 * Las secciones de la hoja de controles, en el orden en que se trabaja: primero
 * se corta el clip, despues se le acomoda el color, y al final se le suman la
 * musica, la capa y la salida.
 */
const PESTANAS = [
  { id: 'clip', etiqueta: 'clip' },
  { id: 'color', etiqueta: 'color' },
  { id: 'musica', etiqueta: 'música' },
  { id: 'capa', etiqueta: 'capa' },
  { id: 'salida', etiqueta: 'salida' },
  { id: 'proyecto', etiqueta: 'proyecto' },
] as const;

type Pestana = (typeof PESTANAS)[number]['id'];

export function App() {
  /*
   * DOS <video> y no uno.
   *
   * Con uno solo, encadenar clips obligaba a cambiarle el `src`: el navegador
   * tira el decodificador, abre el archivo nuevo, parsea el contenedor y busca
   * un keyframe. Eso es un hueco de imagen en CADA corte, y como la musica va
   * por WebAudio y no se entera, el tiron se notaba todavia mas.
   *
   * Ahora hay dos y se turnan: mientras suena uno, el otro ya cargo el clip
   * siguiente y quedo parado en su marca de entrada. El corte es un cambio de
   * cual se dibuja, sin carga ni busqueda.
   */
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const [activo, setActivo] = useState<'a' | 'b'>('a');
  /** Lo mismo que `activo`, para leerlo desde los callbacks sin recrearlos. */
  const activoRef = useRef<'a' | 'b'>('a');
  /**
   * El <video> que esta en pantalla. No es el ref de un elemento del JSX: lo
   * apunta el efecto de abajo al que toque. Todo el resto del componente lo usa
   * como antes, sin enterarse de que hay dos.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** El clip que ya quedo cargado y buscado en el <video> ocioso, si hay. */
  const listoRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** La zona que scrollea: hay que devolverla arriba al cambiar de pestana. */
  const cuerpoRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<LutRenderer | null>(null);
  const bypassRef = useRef(false);
  /**
   * La correccion de estabilizacion de cada clip que la tenga, por id.
   *
   * Es un mapa y no una sola porque antes era una sola: estabilizar el clip A,
   * pasar al B y volver perdia lo del A, y el export salia con un solo clip
   * corregido. Guardar por id deja estabilizar todo el montaje de a un clip.
   *
   * Va en un ref y no en estado porque la consume el bucle de dibujo: guardarla
   * en useState re-montaria el bucle en cada cambio de deslizador.
   */
  const estabRef = useRef<Map<string, Estabilizacion>>(new Map());
  /**
   * El instante EXACTO del cuadro que el <video> tiene en pantalla, segun
   * requestVideoFrameCallback (mediaTime). Es distinto de video.currentTime:
   * currentTime es el reloj de reproduccion y puede ir uno o dos cuadros
   * adelante o atras del cuadro realmente decodificado. Para el color no
   * importa; para la estabilizacion es la diferencia entre corregir el temblor
   * y agregarle otro: un error de 40-80 ms en un temblor de caminar (5-10 Hz)
   * corrige con la fase equivocada, y la imagen se ve PEOR que sin corregir.
   * Es exactamente lo que paso en las primeras pruebas con clips reales.
   */
  const tiempoCuadroRef = useRef<number | null>(null);
  const framingRef = useRef<Framing | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Lo mismo que `todo`, pero para los efectos: leerlo no los re-suscribe. */
  const todoRef = useRef(false);
  /**
   * Marca que el cambio de clip lo hizo la cadena y no el dedo del usuario. Sin
   * esto, tocar otro chip mientras corre `todo()` seguiria reproduciendo con la
   * musica corrida; con esto, el toque manual frena, como siempre.
   */
  const avanceRef = useRef(false);
  const clipsRef = useRef<TimelineClip[]>([]);
  const capaRef = useRef<OverlayLayer | null>(null);
  /** El bucle de dibujo necesita saber en que segundo del montaje esta parado. */
  const lineaRef = useRef({ offset: 0, trimIn: 0, speed: 1 });

  /*
   * Quien es el video de pantalla y quien el de reserva.
   *
   * Va en useLayoutEffect y no en useEffect a proposito: los de layout corren
   * ANTES que todos los useEffect, asi que cuando el bucle de dibujo o el salto
   * de clip leen `videoRef.current`, ya apunta al que corresponde. Sin dependencias
   * porque tiene que revisarse en cada render, incluido el primer montaje.
   */
  useLayoutEffect(() => {
    activoRef.current = activo;
    videoRef.current = activo === 'a' ? videoARef.current : videoBRef.current;
  });

  /** El <video> de reserva: el que no se esta viendo. */
  const videoOcioso = useCallback(
    () => (activoRef.current === 'a' ? videoBRef.current : videoARef.current),
    [],
  );
  /**
   * Un segundo puntual DENTRO del clip al que estamos saltando. Lo deja puesto
   * un salto desde la barra de la capa, que habla en tiempo de linea de tiempo
   * y puede caer en un clip que todavia no es el seleccionado.
   */
  const saltoRef = useRef<number | null>(null);
  /**
   * Si al soltar la barra general hay que volver a reproducir. Se pone cuando
   * el arrastre interrumpio una cadena que venia sonando: el dedo frena, y al
   * soltar se retoma desde el punto nuevo.
   */
  const reanudarRef = useRef(false);
  /**
   * `reproducirDesdeElCabezal` visto desde arriba: el salto de clip termina en
   * un efecto que se declara antes que esa funcion, y desde ahi hay que poder
   * retomar la reproduccion cuando el archivo nuevo ya tiene cuadro.
   */
  const reproducirRef = useRef<() => void>(() => {});
  const audioCtxRef = useRef<AudioContext | null>(null);
  const musicNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);
  const musicRafRef = useRef<number | null>(null);
  const musicRef = useRef<MusicTrack | null>(null);
  /** Desde donde arranco la escucha y en que momento del contexto: da el cabezal. */
  const musicAnchorRef = useRef<{ desde: number; ctxTime: number } | null>(null);

  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lutLibrary, setLutLibrary] = useState<LibraryLut[]>([]);
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const [musicBusy, setMusicBusy] = useState(false);
  /** El cabezal de la barra de musica, en segundos del tema. */
  const [musicTime, setMusicTime] = useState(0);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [preset, setPreset] = useState<ExportPreset>(DEFAULT_PRESET);
  const [currentTime, setCurrentTime] = useState(0);
  const [bypass, setBypass] = useState(false);
  /** Si el visor deja bajarle el volumen al clip. En iOS no. */
  const [volumenAjustable, setVolumenAjustable] = useState(true);
  const [playing, setPlaying] = useState(false);
  /** Si esta corriendo la cadena de todos los clips, para la etiqueta del boton. */
  const [todo, setTodo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [listo, setListo] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [capa, setCapa] = useState<OverlayLayer | null>(null);
  const [capaBusy, setCapaBusy] = useState(false);
  /** Que mueve el dedo cuando se arrastra sobre el visor: el clip o la capa. */
  const [arrastra, setArrastra] = useState<'clip' | 'capa'>('clip');
  /** Que seccion de la hoja de controles se ve. */
  const [pestana, setPestana] = useState<Pestana>('clip');

  bypassRef.current = bypass;
  clipsRef.current = clips;
  // El bucle que mueve el cabezal lee de aca, no de la clausura: si no, marcar
  // la salida mientras suena el tema no frenaria hasta la salida vieja.
  musicRef.current = music;

  const selected = clips.find((c) => c.id === selectedId) ?? null;
  /** Su lugar en el montaje: lo muestran la tira y las acciones de la pestana. */
  const indiceSeleccionado = clips.findIndex((c) => c.id === selectedId);
  const lutConv = selected ? (lutLibrary.find((l) => l.id === selected.lutConvId) ?? null) : null;
  const lutLook = selected ? (lutLibrary.find((l) => l.id === selected.lutLookId) ?? null) : null;

  const duration = selected?.info.durationSeconds ?? 0;
  const sourceFps = selected?.info.frameRate ?? DEFAULT_FRAME_RATE;
  const trimIn = selected?.trimIn ?? 0;
  const trimOut = selected?.trimOut ?? 0;
  const speed = selected?.speed ?? 1;
  const fit = selected?.fit ?? 'cover';
  const panX = selected?.panX ?? 0;
  const panY = selected?.panY ?? 0;
  const volume = selected?.volume ?? 1;
  const lift = selected?.lift ?? GRADE_NEUTRO.lift;
  const gamma = selected?.gamma ?? GRADE_NEUTRO.gamma;
  const gain = selected?.gain ?? GRADE_NEUTRO.gain;
  const gradeNeutro = esNeutro({ lift, gamma, gain });
  /** Los segundos de material que sobreviven al recorte, antes de la velocidad. */
  const material = Math.max(0, trimOut - trimIn);

  const hayClip = selected !== null;

  /** Si el clip seleccionado va a sonar con su propio audio, o queda mudo. */
  const usaSuAudio = selected
    ? clipAportaAudio({
        hasAudio: selected.info.hasAudio,
        audioCanDecode: selected.info.audioCanDecode,
        volume: selected.volume,
        speed: selected.speed,
      })
    : false;

  /** En que segundo de la linea de tiempo arranca el clip seleccionado. */
  const offsetSeleccionado = useMemo(() => {
    let acc = 0;
    for (const c of clips) {
      if (c.id === selectedId) break;
      acc += clipOutputDuration(c);
    }
    return acc;
  }, [clips, selectedId]);

  // El bucle de dibujo lee de aca y no de la clausura, igual que bypassRef: asi
  // mover un deslizador no lo obliga a re-suscribirse.
  capaRef.current = capa;
  lineaRef.current = { offset: offsetSeleccionado, trimIn, speed };

  const velocidadConforme = useMemo(
    () => conformSpeed(sourceFps, DEFAULT_FRAME_RATE),
    [sourceFps],
  );
  const duracionTotal = useMemo(
    () => clips.reduce((acc, c) => acc + clipOutputDuration(c), 0),
    [clips],
  );

  /**
   * El cabezal del MONTAJE. `currentTime` son segundos del archivo del clip
   * seleccionado; esto los traduce a segundos del proyecto, que es en lo que
   * hablan la barra global, la capa y la musica.
   */
  const tiempoGlobal = hayClip
    ? tiempoEnLaLinea(offsetSeleccionado, currentTime, trimIn, speed)
    : 0;

  /** Lo que la barra global necesita saber de cada clip: cuanto ocupa. */
  const tramos = useMemo(
    () => clips.map((c) => ({ id: c.id, duracion: clipOutputDuration(c) })),
    [clips],
  );

  // Si el clip seleccionado se borra, cae en el que haya quedado en su lugar.
  useEffect(() => {
    if (selectedId && clips.some((c) => c.id === selectedId)) return;
    setSelectedId(clips[0]?.id ?? null);
  }, [clips, selectedId]);

  // Al desmontar, libera los blobs y la imagen que queden vivos.
  useEffect(
    () => () => {
      for (const c of clipsRef.current) URL.revokeObjectURL(c.url);
      capaRef.current?.bitmap.close();
    },
    [],
  );

  const updateSelected = useCallback(
    (patch: Partial<TimelineClip>) => {
      setClips((prev) => prev.map((c) => (c.id === selectedId ? { ...c, ...patch } : c)));
    },
    [selectedId],
  );

  /**
   * Mueve un ajuste de estabilizacion del clip seleccionado.
   *
   * Aparte de updateSelected porque hay que fusionar contra lo que el clip ya
   * tiene: un patch plano pisaria los otros diez ajustes con undefined.
   */
  const cambiarGiro = useCallback(
    (parcial: Partial<AjustesGiro>) => {
      setClips((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, giro: { ...c.giro, ...parcial } } : c)),
      );
    },
    [selectedId],
  );

  const updateCapa = useCallback((patch: Partial<OverlayLayer>) => {
    setCapa((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  /**
   * El contexto de audio se crea recien cuando el usuario toca algo: iOS no deja
   * que arranque solo, y uno creado antes del primer gesto queda suspendido.
   */
  const getAudioCtx = useCallback(() => {
    audioCtxRef.current ??= new AudioContext();
    void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  /**
   * Corta cualquier musica que este sonando, sea la de la linea de tiempo o la
   * escucha suelta de la barra. Como es una sola cadena de nodos, las dos no se
   * pueden pisar: la que arranca ultima manda.
   */
  const detenerMusica = useCallback(() => {
    if (musicRafRef.current !== null) {
      cancelAnimationFrame(musicRafRef.current);
      musicRafRef.current = null;
    }
    musicAnchorRef.current = null;
    setMusicPlaying(false);

    const nodo = musicNodeRef.current;
    if (!nodo) return;
    try {
      nodo.stop();
    } catch {
      // Ya se habia terminado sola; nada que frenar.
    }
    nodo.disconnect();
    musicNodeRef.current = null;
    musicGainRef.current = null;
  }, []);

  /**
   * Arranca la musica desde el segundo que le toca en la linea de tiempo, no
   * desde el principio del tema: reproduciendo el tercer clip se escucha lo que
   * va a sonar ahi en el MP4 final.
   */
  const arrancarMusica = useCallback(
    (posicionEnLaLinea: number) => {
      detenerMusica();
      if (!music || music.volume <= 0) return;

      const desde = music.startInMusic + posicionEnLaLinea;
      if (desde < 0 || desde >= music.endInMusic) return;

      const ctx = getAudioCtx();
      const fuente = ctx.createBufferSource();
      fuente.buffer = music.buffer;
      const ganancia = ctx.createGain();
      ganancia.gain.value = music.volume;
      fuente.connect(ganancia).connect(ctx.destination);
      // Con la duracion, para que la musica corte en la marca de salida.
      fuente.start(0, desde, music.endInMusic - desde);

      musicNodeRef.current = fuente;
      musicGainRef.current = ganancia;
    },
    [music, detenerMusica, getAudioCtx],
  );

  /**
   * Escucha el tema solo, sin el video, para poder marcar entrada y salida de
   * oido. Es el equivalente a reproducir el clip mientras se lo recorta: sin
   * esto hay que adivinar donde cae el estribillo.
   */
  const escucharMusica = useCallback(
    (desde: number) => {
      // El video se pausa: dos audios encima no dejan marcar nada.
      videoRef.current?.pause();
      todoRef.current = false;
      setTodo(false);
      setPlaying(false);
      detenerMusica();
      if (!music) return;

      const hasta = music.endInMusic;
      const arranque = desde < music.startInMusic || desde >= hasta ? music.startInMusic : desde;
      if (arranque >= hasta) return;

      const ctx = getAudioCtx();
      const fuente = ctx.createBufferSource();
      fuente.buffer = music.buffer;
      const ganancia = ctx.createGain();
      ganancia.gain.value = music.volume;
      fuente.connect(ganancia).connect(ctx.destination);
      fuente.start(0, arranque, hasta - arranque);

      musicNodeRef.current = fuente;
      musicGainRef.current = ganancia;
      musicAnchorRef.current = { desde: arranque, ctxTime: ctx.currentTime };
      setMusicPlaying(true);
      setMusicTime(arranque);

      const seguir = () => {
        const ancla = musicAnchorRef.current;
        const actual = musicRef.current;
        if (!ancla || !actual) return;
        // El nodo ya tiene programado su corte en `hasta`, asi que mover la
        // salida mas adelante mientras suena no lo alarga: frena en el primero
        // de los dos. Moverla antes si acorta, y ahi frena el bucle.
        const limite = Math.min(hasta, actual.endInMusic);
        const posicion = ancla.desde + (ctx.currentTime - ancla.ctxTime);
        if (posicion >= limite) {
          // Al llegar a la salida vuelve a la entrada, igual que el video.
          detenerMusica();
          setMusicTime(actual.startInMusic);
          return;
        }
        setMusicTime(posicion);
        musicRafRef.current = requestAnimationFrame(seguir);
      };
      musicRafRef.current = requestAnimationFrame(seguir);
    },
    [music, detenerMusica, getAudioCtx],
  );

  const updateMusic = useCallback((patch: Partial<MusicTrack>) => {
    setMusic((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // El lienzo tiene la forma del preset, para que lo que se ve sea lo que sale.
  const previewSize = useMemo(() => {
    const escala = Math.min(1, PREVIEW_MAX_SIDE / Math.max(preset.width, preset.height));
    return {
      width: Math.round(preset.width * escala),
      height: Math.round(preset.height * escala),
    };
  }, [preset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new LutRenderer(canvas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setLut('conv', lutConv?.lut ?? null);
  }, [lutConv]);

  useEffect(() => {
    rendererRef.current?.setLut('look', lutLook?.lut ?? null);
  }, [lutLook]);

  // Las dependencias son los tres numeros y no un objeto: uno armado aca cambiaria
  // de identidad en cada render y volveria a subir los uniforms sin motivo.
  useEffect(() => {
    rendererRef.current?.setGrade({ lift, gamma, gain });
  }, [lift, gamma, gain]);

  // La imagen de la capa se sube a la GPU al cambiarla, no en cada cuadro: un
  // PNG no cambia entre un cuadro y el siguiente.
  useEffect(() => {
    rendererRef.current?.setOverlay(capa?.bitmap ?? null);
  }, [capa]);

  // Si se acortan o se borran clips, la capa puede quedar marcada mas alla del
  // final del montaje. Se recorta sola para que la barra no muestre una salida
  // que ya no existe.
  useEffect(() => {
    setCapa((prev) => {
      if (!prev) return prev;
      const fin = Math.min(prev.endSeconds, duracionTotal);
      const inicio = Math.min(prev.startSeconds, fin);
      if (fin === prev.endSeconds && inicio === prev.startSeconds) return prev;
      return { ...prev, startSeconds: inicio, endSeconds: fin };
    });
  }, [duracionTotal]);

  // Al cambiar de clip seleccionado, el visor salta a su marca de entrada. Si el
  // cambio lo hizo la cadena de `todo()`, ademas sigue reproduciendo sin tocar la
  // musica, que viene sonando de corrido desde que arranco.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selected) return undefined;
    const enCadena = avanceRef.current;
    avanceRef.current = false;
    if (!enCadena) {
      setPlaying(false);
      detenerMusica();
    }
    // Si el salto vino de la barra de la capa hay un segundo puntual pedido; si
    // no, se cae en la marca de entrada del clip, que es lo de siempre.
    const target = saltoRef.current ?? selected.trimIn;
    saltoRef.current = null;

    // El camino rapido de la cadena: este <video> ya venia con el clip cargado
    // y parado en su marca, y `avanzarOTerminar` ya le dio play. Volver a
    // cargarlo o a buscarlo seria pedir el trabajo que se acaba de ahorrar,
    // justo en el cuadro del corte.
    const yaCargado = video.dataset.clipId === selected.id && video.dataset.clipUrl === selected.url;
    if (enCadena && yaCargado) {
      setCurrentTime(video.currentTime);
      return undefined;
    }

    const hayQueCargar = !yaCargado;
    if (hayQueCargar) {
      video.dataset.clipId = selected.id;
      video.dataset.clipUrl = selected.url;
      video.src = selected.url;
    }

    // Se espera `seeked` y no `loadedmetadata` para arrancar. Con metadata hay
    // duracion y tamano pero todavia NINGUN cuadro decodificado: el play caia
    // en `waiting` y el bucle de dibujo descartaba cuadros por readyState < 2,
    // o sea imagen congelada. Con `seeked` hay cuadro en el instante exacto.
    const arrancar = () => {
      setCurrentTime(video.currentTime);
      if (enCadena) {
        void video.play();
        setPlaying(true);
        return;
      }
      // El arrastre de la barra general solto el dedo en OTRO clip: recien
      // ahora, con cuadro decodificado, se puede retomar la reproduccion.
      if (reanudarRef.current) {
        reanudarRef.current = false;
        reproducirRef.current();
      }
    };
    const buscar = () => {
      if (Math.abs(video.currentTime - target) < 1e-3) {
        arrancar();
        return;
      }
      video.addEventListener('seeked', arrancar, { once: true });
      video.currentTime = target;
      setCurrentTime(target);
    };
    if (hayQueCargar || video.readyState < 1) {
      video.addEventListener('loadedmetadata', buscar, { once: true });
    } else {
      buscar();
    }
    return () => {
      video.removeEventListener('loadedmetadata', buscar);
      video.removeEventListener('seeked', arrancar);
    };
  }, [selectedId]);

  /*
   * Precarga del clip siguiente en el <video> de reserva.
   *
   * Solo con la cadena corriendo: fuera de ahi no se sabe cual va a ser el
   * proximo clip, y dos decodificadores vivos ocupan memoria de mas (en el
   * iPhone es lo que mas importa). Por eso, apenas la cadena se apaga, se le
   * suelta el archivo al de reserva.
   */
  useEffect(() => {
    const reserva = videoOcioso();
    if (!reserva) return undefined;

    const idx = clips.findIndex((c) => c.id === selectedId);
    const siguiente = todo && playing && idx >= 0 ? clips[idx + 1] : undefined;

    if (!siguiente) {
      if (reserva.dataset.clipId) {
        reserva.removeAttribute('src');
        delete reserva.dataset.clipId;
        delete reserva.dataset.clipUrl;
        reserva.load();
      }
      listoRef.current = null;
      return undefined;
    }

    if (reserva.dataset.clipId === siguiente.id && reserva.dataset.clipUrl === siguiente.url)
      return undefined;

    listoRef.current = null;
    reserva.dataset.clipId = siguiente.id;
    reserva.dataset.clipUrl = siguiente.url;
    reserva.muted = true;
    reserva.preload = 'auto';
    reserva.src = siguiente.url;

    const marcarListo = () => {
      listoRef.current = siguiente.id;
    };
    const buscar = () => {
      // La velocidad se fija ACA, antes del cambio. Al cargar un archivo nuevo
      // el navegador vuelve a 1x, y sin esto el clip precargado arrancaba a
      // velocidad normal aunque fuera camara lenta.
      try {
        const rate = Math.min(4, Math.max(0.25, siguiente.speed));
        reserva.defaultPlaybackRate = rate;
        reserva.playbackRate = rate;
      } catch {
        // Si la rechaza, ese clip se ve a velocidad normal, como antes.
      }
      if (Math.abs(reserva.currentTime - siguiente.trimIn) < 1e-3) {
        marcarListo();
        return;
      }
      reserva.addEventListener('seeked', marcarListo, { once: true });
      reserva.currentTime = siguiente.trimIn;
    };
    reserva.addEventListener('loadedmetadata', buscar, { once: true });

    return () => {
      reserva.removeEventListener('loadedmetadata', buscar);
      reserva.removeEventListener('seeked', marcarListo);
    };
  }, [todo, playing, selectedId, clips, activo, videoOcioso]);

  /**
   * En el iPhone y el iPad `video.volume` es de solo lectura: la asignacion se
   * ignora sin tirar error y al leerla siempre vuelve 1, porque ahi el volumen
   * lo maneja el boton fisico. No hay forma de preguntarlo, asi que se prueba
   * en caliente una sola vez: se escribe un valor y se lee de vuelta.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const previo = video.volume;
    video.volume = 0.5;
    setVolumenAjustable(Math.abs(video.volume - 0.5) < 1e-6);
    video.volume = previo;
  }, []);

  // El sonido del clip y su velocidad de reproduccion. Sin el playbackRate, la
  // camara lenta no se veia hasta exportar y la musica se desincronizaba.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !usaSuAudio;
    video.volume = Math.min(1, Math.max(0, volume));
    try {
      // Los navegadores solo aceptan un rango acotado de velocidades.
      const rate = Math.min(4, Math.max(0.25, speed));
      // defaultPlaybackRate ademas: al cambiar de archivo, el navegador vuelve a
      // esa, y sin fijarla el clip nuevo arrancaba siempre a 1x.
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    } catch {
      // Si la rechaza, el visor sigue a velocidad normal.
    }
    // `activo` en las deps: al cambiar de <video> hay que reponerle el volumen y
    // la velocidad al que entra, que venia mudo de la precarga.
  }, [usaSuAudio, volume, speed, selectedId, activo]);

  // El volumen de la musica se puede mover mientras suena.
  useEffect(() => {
    if (musicGainRef.current && music) musicGainRef.current.gain.value = music.volume;
  }, [music]);

  // Al desmontar, corta cualquier sonido que haya quedado vivo.
  useEffect(
    () => () => {
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    },
    [],
  );

  // El encuadre vive en un ref para que el bucle de dibujo no se reinicie con
  // cada movimiento del deslizador de recorte.
  useEffect(() => {
    if (!selected) {
      framingRef.current = null;
      return;
    }
    framingRef.current = {
      // El <video> ya entrega el cuadro rotado, asi que aca no queda rotacion
      // pendiente y las dimensiones son las de presentacion.
      textureWidth: selected.info.displayWidth,
      textureHeight: selected.info.displayHeight,
      rotation: 0,
      mode: fit,
      panX,
      panY,
    };
  }, [selected, fit, panX, panY]);

  // Cuanto material sobra fuera del lienzo: es lo unico que se puede reencuadrar.
  const sobrante = useMemo(() => {
    if (!selected) return { overflowX: 0, overflowY: 0 };
    const { overflowX, overflowY } = computeFit(
      {
        textureWidth: selected.info.displayWidth,
        textureHeight: selected.info.displayHeight,
        rotation: 0,
        mode: fit,
      },
      preset.width,
      preset.height,
    );
    return { overflowX, overflowY };
  }, [selected, fit, preset]);

  const sePuedeReencuadrar = sobrante.overflowX > 0.001 || sobrante.overflowY > 0.001;
  /** Si el dedo sobre el visor mueve la capa en vez de reencuadrar el clip. */
  const moviendoCapa = arrastra === 'capa' && capa !== null;
  const sePuedeArrastrar = moviendoCapa || sePuedeReencuadrar;

  // Arrastrar sobre la imagen para reencuadrar: en el telefono es mas directo
  // que un deslizador, y es el gesto que uno espera al mover un encuadre.
  const arrastre = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const onArrastreInicio = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!sePuedeArrastrar) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      arrastre.current = {
        x: e.clientX,
        y: e.clientY,
        panX,
        panY,
        offsetX: capa?.offsetX ?? 0,
        offsetY: capa?.offsetY ?? 0,
      };
    },
    [sePuedeArrastrar, panX, panY, capa],
  );

  const onArrastreMovimiento = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const inicio = arrastre.current;
      if (!inicio) return;
      const rect = e.currentTarget.getBoundingClientRect();

      if (moviendoCapa) {
        // Mover la capa es mas simple que reencuadrar el clip: el desplazamiento
        // ya esta en NDC, asi que no hay que dividirlo por el sobrante. Una capa
        // se puede poner donde uno quiera, no solo donde sobra imagen.
        const dx = (2 * (e.clientX - inicio.x)) / rect.width;
        const dy = (2 * (e.clientY - inicio.y)) / rect.height;
        updateCapa({
          offsetX: limitarOffset(inicio.offsetX + dx),
          // El eje Y de la pantalla crece hacia abajo y el de NDC hacia arriba.
          offsetY: limitarOffset(inicio.offsetY - dy),
        });
        return;
      }

      const patch: Partial<TimelineClip> = {};
      // Un desplazamiento de 1 en pan mueve la imagen justo lo que sobra, asi que
      // convertir pixeles a pan es dividir por el sobrante.
      if (sobrante.overflowX > 0.001) {
        const delta = (2 * (e.clientX - inicio.x)) / (rect.width * sobrante.overflowX);
        patch.panX = Math.min(1, Math.max(-1, inicio.panX + delta));
      }
      if (sobrante.overflowY > 0.001) {
        const delta = (2 * (e.clientY - inicio.y)) / (rect.height * sobrante.overflowY);
        // El eje Y de la pantalla crece hacia abajo y el de NDC hacia arriba.
        patch.panY = Math.min(1, Math.max(-1, inicio.panY - delta));
      }
      updateSelected(patch);
    },
    [moviendoCapa, updateCapa, sobrante, updateSelected],
  );

  const onArrastreFin = useCallback(() => {
    arrastre.current = null;
  }, []);

  /**
   * El tamano del lienzo sigue al PRESET, no al clip.
   *
   * Estaba adentro del bucle de dibujo, que arranca con un return si no hay clip
   * seleccionado. Sin ese resize el canvas se queda con su tamano por defecto
   * -300x150, o sea 2:1- mientras el CSS le impone una caja con el aspectRatio
   * del preset, y el navegador estira ese bufer para llenarla. Eso es un cuadro
   * aplastado, y se nota mas en 9:16 porque es donde mas difieren las dos
   * proporciones.
   */
  useEffect(() => {
    rendererRef.current?.resize(previewSize.width, previewSize.height);
  }, [previewSize]);

  // Bucle de dibujo: cada cuadro que entrega el decodificador pasa por el shader.
  useEffect(() => {
    const video = videoRef.current;
    const renderer = rendererRef.current;
    if (!video || !renderer || !selected) return;

    let stop = false;
    let handle = 0;

    const paint = () => {
      const framing = framingRef.current;
      if (stop || !framing || video.readyState < 2) return;
      try {
        renderer.clear();
        /*
         * La correccion depende del momento del clip: se pide por cuadro.
         *
         * Se comprueba de que clip es porque sobrevive a cerrar el panel del
         * giroscopio (si no, ir a "salida" a exportar la perdia). Sin esta
         * comparacion, la correccion de un clip se le aplicaria al siguiente.
         */
        const estab = estabRef.current.get(selected.id) ?? null;
        // En pausa currentTime es exacto (el cuadro se busco a ese instante);
        // reproduciendo, vale el mediaTime del ultimo cuadro presentado.
        const instante =
          !video.paused && tiempoCuadroRef.current !== null
            ? tiempoCuadroRef.current
            : video.currentTime;
        renderer.setEstabilizacion(estab ? estab.muestreoEn(instante) : null);
        renderer.draw(video, framing, bypassRef.current);

        const capaActual = capaRef.current;
        if (capaActual) {
          const { offset, trimIn: entrada, speed: velocidad } = lineaRef.current;
          const enLaLinea = tiempoEnLaLinea(offset, video.currentTime, entrada, velocidad);
          if (capaVisibleEn(capaActual, enLaLinea)) {
            const animada = capaEnSegundo(capaActual, enLaLinea);
            renderer.drawOverlay(
              framingDeCapa({ ...capaActual, scale: animada.scale }),
              animada.opacity,
            );
          }
        }
      } catch {
        // Un cuadro perdido no justifica romper el visor.
      }
      setCurrentTime(video.currentTime);
    };

    // rAF puro y no requestVideoFrameCallback: rVFC solo dispara cuando el
    // video decodifica un cuadro NUEVO, asi que con el video en pausa (el
    // estado normal al recien importar, antes de tocar play) dejaba de
    // redibujar y arrastrar para reencuadrar parecia no hacer nada.
    const loop = () => {
      paint();
      if (!stop) handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);

    // Y ADEMAS rVFC, solo para anotar el instante exacto de cada cuadro nuevo.
    // No dibuja: el dibujo sigue en el rAF de arriba. Ver tiempoCuadroRef.
    let handleVfc = 0;
    const conVfc = 'requestVideoFrameCallback' in video;
    const anotar = (_ahora: number, meta: { mediaTime: number }) => {
      tiempoCuadroRef.current = meta.mediaTime;
      if (!stop) handleVfc = video.requestVideoFrameCallback(anotar);
    };
    if (conVfc) handleVfc = video.requestVideoFrameCallback(anotar);

    return () => {
      stop = true;
      cancelAnimationFrame(handle);
      if (conVfc && handleVfc) video.cancelVideoFrameCallback(handleVfc);
      tiempoCuadroRef.current = null;
    };
    // `activo` en las deps: el bucle tiene que redibujar y anotar los cuadros
    // del <video> que acaba de entrar, no los del que quedo de reserva.
  }, [selected, previewSize, activo]);

  /**
   * Que hacer cuando el clip llega a su marca de salida. Con la cadena prendida
   * salta al siguiente; si no, o si era el ultimo, frena y vuelve a la entrada.
   *
   * La musica no se toca al saltar: el nodo arranco con su duracion programada y
   * corre solo en el AudioContext, asi que cruza el corte sin enterarse. Es lo
   * que hace que el montaje se escuche de corrido aunque el video parpadee.
   */
  const avanzarOTerminar = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (todoRef.current) {
      const idx = clips.findIndex((c) => c.id === selectedId);
      const siguiente = clips[idx + 1];
      if (siguiente) {
        avanceRef.current = true;
        const reserva = videoOcioso();
        // El corte sin hueco: la reserva ya tiene el archivo abierto y esta
        // parada en la marca de entrada, asi que esto es solo cambiar cual se
        // dibuja. Si la precarga no llego a tiempo -clip cortito, disco lento-
        // se cae al camino de siempre, que carga en el efecto de seleccion.
        if (reserva && listoRef.current === siguiente.id) {
          reserva.muted = video.muted;
          reserva.volume = video.volume;
          video.pause();
          void reserva.play();
          listoRef.current = null;
          setActivo((a) => (a === 'a' ? 'b' : 'a'));
        } else {
          video.pause();
        }
        // `playing` queda en true a proposito: asi este mismo efecto se
        // re-suscribe con las marcas del clip nuevo y no se corta la cadena.
        setSelectedId(siguiente.id);
        return;
      }
      // Era el ultimo: se termino el recorrido.
      todoRef.current = false;
      setTodo(false);
    }

    video.pause();
    video.currentTime = trimIn;
    setPlaying(false);
    detenerMusica();
  }, [clips, selectedId, trimIn, detenerMusica, videoOcioso]);

  /*
   * Al reproducir, frena en la marca de salida en vez de seguir hasta el final.
   *
   * Se mira cuadro a cuadro con requestVideoFrameCallback. Antes era un
   * setInterval de 60 ms, o sea que el corte podia llegar hasta dos cuadros
   * tarde; con el cambio de clip ya instantaneo, ese retraso pasaba a ser lo
   * mas visible que quedaba. El intervalo sigue de red por si el navegador no
   * tiene rVFC, y porque rVFC no dispara con el video pausado.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    let corto = false;
    const check = () => {
      if (corto) return;
      if (video.currentTime >= trimOut) {
        corto = true;
        avanzarOTerminar();
      }
    };
    const id = setInterval(check, 60);
    let handle = 0;
    const conVfc = 'requestVideoFrameCallback' in video;
    const porCuadro = () => {
      check();
      if (!corto) handle = video.requestVideoFrameCallback(porCuadro);
    };
    if (conVfc) handle = video.requestVideoFrameCallback(porCuadro);
    return () => {
      corto = true;
      clearInterval(id);
      if (conVfc && handle) video.cancelVideoFrameCallback(handle);
    };
  }, [playing, trimOut, avanzarOTerminar, activo]);

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = seconds;
      setCurrentTime(seconds);
      // Si estaba sonando, la musica salta con la imagen en vez de quedar corrida.
      if (video.paused) detenerMusica();
      else arrancarMusica(offsetSeleccionado + (seconds - trimIn) / speed);
    },
    [arrancarMusica, detenerMusica, offsetSeleccionado, trimIn, speed],
  );

  /**
   * Lleva el visor a un segundo de la LINEA DE TIEMPO, saltando de clip si hace
   * falta. Es lo que hace falta para que marcar la entrada y la salida de la
   * capa muestre el cuadro que se esta marcando, aunque caiga en otro clip.
   */
  const irALaLinea = useCallback(
    (segundos: number, opts?: { arrastrando?: boolean }) => {
      const video = videoRef.current;
      if (!video || clips.length === 0) return;

      let acc = 0;
      for (const [i, c] of clips.entries()) {
        const dura = clipOutputDuration(c);
        const ultimo = i === clips.length - 1;
        if (segundos < acc + dura || ultimo) {
          // Dentro del archivo hay que volver a comprimir por la velocidad: lo
          // que en el montaje son dos segundos, a media velocidad es uno solo.
          const dentro = Math.min(
            c.trimOut,
            Math.max(c.trimIn, c.trimIn + (segundos - acc) * c.speed),
          );
          const cargando = video.dataset.clipId !== c.id || video.readyState < 1;
          if (c.id === selectedId) {
            // Arrastrando, si el archivo todavia esta cargando no se lo toca:
            // escribirle el tiempo ahora pisaria la busqueda en curso, y el
            // cuadro siguiente del gesto vuelve a intentar igual.
            if (opts?.arrastrando && cargando) return;
            video.currentTime = dentro;
            setCurrentTime(dentro);
            // Durante el arrastre la musica ya viene frenada; reengancharla en
            // cada cuadro la dejaria tartamudeando.
            if (opts?.arrastrando) return;
            // Saltar mientras suena dejaria la musica corrida contra la imagen;
            // se la reengancha en el segundo nuevo, igual que hace `seek`.
            if (video.paused) detenerMusica();
            else arrancarMusica(segundos);
          } else {
            // Cambiar de clip recarga el <video>; el efecto de [selectedId] va a
            // recoger este segundo cuando el archivo nuevo este listo.
            saltoRef.current = dentro;
            setSelectedId(c.id);
          }
          return;
        }
        acc += dura;
      }
    },
    [clips, selectedId, arrancarMusica, detenerMusica],
  );

  /**
   * Se queda con una copia del archivo adentro de la app.
   *
   * Es lo que evita tener que buscar el clip de nuevo cada vez que se reabre el
   * proyecto: en el telefono el material esta repartido entre Fotos y Archivos
   * y no hay forma de que el navegador lo vuelva a abrir solo.
   *
   * No se espera a que termine: son cientos de megas y el clip ya se puede
   * editar mientras se escribe. Si no entra -tipicamente la cuota- el montaje
   * anda igual y lo unico que se pierde es la comodidad, asi que se avisa y se
   * sigue.
   */
  const guardarCopia = useCallback((file: File) => {
    void guardarMedio(file).then((hecho) => {
      if (hecho) return;
      setAvisos((prev) => [
        ...prev.filter((a) => !a.startsWith('No entró la copia')),
        `No entró la copia de "${file.name}" en el almacenamiento del navegador: al reabrir el proyecto se va a pedir ese archivo a mano.`,
      ]);
    });
  }, []);

  const onPickClips = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setListo(null);
    setBusy(true);

    const nuevos: TimelineClip[] = [];
    const fallos: string[] = [];

    for (const file of Array.from(fileList)) {
      try {
        const info = await probeClip(file);
        guardarCopia(file);
        nuevos.push({
          id: nextId('clip'),
          file,
          url: URL.createObjectURL(file),
          info,
          warnings: clipWarnings(info),
          lutConvId: null,
          lutLookId: null,
          ...GRADE_NEUTRO,
          fit: 'cover',
          panX: 0,
          panY: 0,
          speed: 1,
          trimIn: 0,
          trimOut: info.durationSeconds,
          volume: 1,
          giro: AJUSTES_POR_DEFECTO,
        });
      } catch (e) {
        fallos.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (nuevos.length > 0) {
      setClips((prev) => [...prev, ...nuevos]);
      setSelectedId(nuevos[0]!.id);
    }
    if (fallos.length > 0) setError(fallos.join(' · '));
    setBusy(false);
  }, []);

  const removeClip = useCallback((id: string) => {
    // Su correccion son matrices por cuadro: sin esto quedan colgando.
    estabRef.current.delete(id);
    setClips((prev) => {
      const victima = prev.find((c) => c.id === id);
      if (victima) URL.revokeObjectURL(victima.url);
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  /**
   * Parte el clip seleccionado en dos por donde quedo el cabezal.
   *
   * El pedazo de la izquierda se queda con el id, y por eso sigue seleccionado:
   * asi el <video> no se recarga y la musica sacada de este clip -que lo busca
   * por id- no se queda huerfana. El de la derecha es un clip nuevo, entra justo
   * atras y a partir de ahi los dos son independientes: se reordenan, se pintan
   * y se borran por separado.
   *
   * La url va aparte y no compartida: `removeClip` revoca la del clip que saca,
   * y con una sola url borrar un pedazo dejaria al hermano en negro.
   */
  const cortarClip = useCallback(() => {
    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === selectedId);
      const clip = prev[idx];
      if (!clip) return prev;
      const corte = partir(clip, currentTime, unCuadro(clip.info.frameRate));
      if (!corte) return prev;

      const copia = prev.slice();
      copia.splice(
        idx,
        1,
        { ...clip, trimOut: corte.izquierda },
        {
          ...clip,
          id: nextId('clip'),
          url: URL.createObjectURL(clip.file),
          trimIn: corte.derecha,
        },
      );
      return copia;
    });
  }, [selectedId, currentTime]);

  /**
   * El reordenamiento del arrastre, que a diferencia de `moveClip` puede saltar
   * varios lugares de una: llevar el cuarto clip al principio corre a los otros
   * tres, no los intercambia.
   */
  const reordenarClips = useCallback((desde: number, hasta: number) => {
    setClips((prev) => moverEnLista(prev, desde, hasta));
  }, []);

  const moveClip = useCallback((id: string, direction: -1 | 1) => {
    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      const next = idx + direction;
      if (idx < 0 || next < 0 || next >= prev.length) return prev;
      const copia = prev.slice();
      const tmp = copia[idx]!;
      copia[idx] = copia[next]!;
      copia[next] = tmp;
      return copia;
    });
  }, []);

  const onUploadLut = useCallback(
    async (file: File | undefined, slot: 'conv' | 'look') => {
      if (!file) return;
      setError(null);
      try {
        const lut = parseCube(await file.text());
        const existente = lutLibrary.find((l) => l.name === file.name);
        const id = existente?.id ?? nextId('lut');
        setLutLibrary((prev) =>
          existente
            ? prev.map((l) => (l.id === id ? { ...l, lut } : l))
            : [...prev, { id, name: file.name, lut }],
        );
        // La biblioteca es lo unico que sobrevive entero al cierre de la app:
        // el .cube pesa poco y volver a subirlo por cada camara en cada sesion
        // seria justo lo que la biblioteca vino a evitar.
        void guardarLut({ id, name: file.name, lut });
        if (selectedId) {
          updateSelected(slot === 'conv' ? { lutConvId: id } : { lutLookId: id });
        }
      } catch (e) {
        setError(`No pude leer "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [lutLibrary, selectedId, updateSelected],
  );

  /**
   * Carga la musica del proyecto. Es el mismo camino para un .mp3 importado y
   * para el audio sacado de un video: `decodeAudioRange` no distingue formato,
   * asi que "extraer el audio de un clip" es pasarle el archivo del clip.
   */
  const cargarMusica = useCallback(
    async (
      file: File | undefined,
      origen: 'archivo' | 'clip',
      nombre: string,
      clipId: string | null = null,
    ) => {
      if (!file) return;
      setError(null);
      setListo(null);
      setMusicBusy(true);
      detenerMusica();
      try {
        const buffer = await decodeAudioRange(file);
        guardarCopia(file);
        setMusic({
          id: nextId('mus'),
          name: nombre,
          origen,
          huella: huellaDe(file),
          clipId,
          buffer,
          duracionSeconds: buffer.duration,
          startInMusic: 0,
          endInMusic: buffer.duration,
          volume: 0.8,
          fadeIn: 0,
          fadeOut: 1.5,
        });
        setMusicTime(0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setMusicBusy(false);
      }
    },
    [detenerMusica],
  );

  const quitarMusica = useCallback(() => {
    detenerMusica();
    setMusic(null);
    setMusicTime(0);
  }, [detenerMusica]);

  const cargarCapa = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      setCapaBusy(true);
      try {
        const imagen = await cargarImagen(file);
        guardarCopia(file);
        // La imagen anterior se libera a mano: un ImageBitmap retiene su buffer
        // hasta que se lo cierra, y cambiar de capa varias veces los acumularia.
        const anterior = capaRef.current;
        setCapa({
          id: nextId('capa'),
          name: file.name,
          huella: huellaDe(file),
          bitmap: imagen.bitmap,
          width: imagen.width,
          height: imagen.height,
          // Por defecto la capa cubre todo el montaje: acortarla es mas facil
          // que buscar donde empieza.
          startSeconds: 0,
          endSeconds: clipsRef.current.reduce((acc, c) => acc + clipOutputDuration(c), 0),
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          opacity: 1,
          // Sin animacion por defecto: la capa aparece y desaparece de golpe.
          // Pero la escala arranca en 0.85, asi que apenas se le da duracion a
          // la entrada se animan el tamano y la opacidad juntos, que es lo que
          // uno espera. Para un fundido puro se lleva ese valor a 1.
          entradaSeconds: 0,
          salidaSeconds: 0,
          scaleEntrada: 0.85,
          scaleSalida: 0.85,
        });
        anterior?.bitmap.close();
        setArrastra('capa');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCapaBusy(false);
      }
    },
    [],
  );

  const quitarCapa = useCallback(() => {
    capaRef.current?.bitmap.close();
    setCapa(null);
    setArrastra('clip');
  }, []);

  /** Frena lo que este sonando y apaga la cadena. */
  const frenar = useCallback(() => {
    videoRef.current?.pause();
    todoRef.current = false;
    setTodo(false);
    setPlaying(false);
    detenerMusica();
  }, [detenerMusica]);

  /**
   * Suelta el material que tiene el editor en la mano.
   *
   * Hay que llamarlo antes de reemplazar el montaje: los blobs de los clips y
   * el bitmap de la capa no los junta el recolector solo, y cambiar de proyecto
   * varias veces sin esto va dejando cada montaje viejo ocupando memoria.
   */
  const soltarMaterial = useCallback(() => {
    // Primero se les saca el archivo a los dos <video>: revocar una URL que un
    // elemento todavia tiene abierta deja el decodificador colgado del blob.
    for (const v of [videoARef.current, videoBRef.current]) {
      if (!v?.dataset.clipId) continue;
      v.removeAttribute('src');
      delete v.dataset.clipId;
      delete v.dataset.clipUrl;
      v.load();
    }
    listoRef.current = null;
    for (const c of clipsRef.current) URL.revokeObjectURL(c.url);
    capaRef.current?.bitmap.close();
  }, []);

  /** Deja el editor como recien abierta la app. */
  const limpiarEditor = useCallback(() => {
    frenar();
    soltarMaterial();
    setClips([]);
    setSelectedId(null);
    setMusic(null);
    setMusicTime(0);
    setCapa(null);
    setArrastra('clip');
    setPreset(DEFAULT_PRESET);
    setCurrentTime(0);
    setError(null);
    setListo(null);
    setAvisos([]);
  }, [frenar, soltarMaterial]);

  /** Entra al editor con un montaje guardado, ya re-vinculado a sus archivos. */
  const aplicarRestaurado = useCallback(
    (restaurado: EstadoRestaurado) => {
      frenar();
      soltarMaterial();
      setClips(restaurado.clips);
      setSelectedId(restaurado.selectedId);
      setMusic(restaurado.music);
      setMusicTime(0);
      setCapa(restaurado.capa);
      setArrastra(restaurado.capa ? 'capa' : 'clip');
      setPreset(restaurado.preset);
      setCurrentTime(0);
      setError(null);
      setListo(null);
      setAvisos(restaurado.avisos);
    },
    [frenar, soltarMaterial],
  );

  const proyecto = useProyecto({
    clips,
    music,
    capa,
    preset,
    selectedId,
    biblioteca: lutLibrary,
    onRestaurar: aplicarRestaurado,
    onLimpiar: limpiarEditor,
    onBiblioteca: setLutLibrary,
  });

  /** El play de siempre: solo el clip seleccionado, entre sus dos marcas. */
  const reproducirClip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Con la cadena corriendo esto no frena: la baja a reproducir solo este clip,
    // que es lo que uno espera al tocar el boton del clip mientras pasa todo.
    if (!video.paused && !todoRef.current) {
      frenar();
      return;
    }
    todoRef.current = false;
    setTodo(false);
    if (video.currentTime < trimIn || video.currentTime >= trimOut) video.currentTime = trimIn;
    void video.play();
    setPlaying(true);
    // La musica se reengancha en el lugar que le toca a este clip en la linea.
    arrancarMusica(offsetSeleccionado + (video.currentTime - trimIn) / speed);
  }, [trimIn, trimOut, speed, offsetSeleccionado, arrancarMusica, frenar]);

  /**
   * El play general: el montaje desde donde quedo el cabezal global, encadenando
   * un clip tras otro hasta el final. Es la forma de ver como quedo sin exportar.
   *
   * Antes arrancaba siempre en el clip 01, y con doce clips ver el final pedia
   * mirar todo lo anterior. Ahora el punto de partida lo elige la barra global,
   * que ya dejo el `<video>` parado en el clip y el segundo que corresponden.
   */
  const reproducirDesdeElCabezal = useCallback(() => {
    const video = videoRef.current;
    if (!video || !selected) return;
    if (todoRef.current) {
      frenar();
      return;
    }

    todoRef.current = true;
    setTodo(true);
    // Si el cabezal quedo fuera del corte del clip (por ejemplo tras mover la
    // marca de salida), se empieza por la entrada, que es lo que se va a ver.
    if (video.currentTime < trimIn || video.currentTime >= trimOut) video.currentTime = trimIn;
    // La musica se engancha en el segundo del montaje donde arranca la imagen.
    arrancarMusica(tiempoEnLaLinea(offsetSeleccionado, video.currentTime, trimIn, speed));
    void video.play();
    setPlaying(true);
  }, [selected, trimIn, trimOut, speed, offsetSeleccionado, arrancarMusica, frenar]);

  useEffect(() => {
    reproducirRef.current = reproducirDesdeElCabezal;
  }, [reproducirDesdeElCabezal]);

  /**
   * El dedo agarro la barra general.
   *
   * Si venia sonando la cadena se frena: mover el cabezal contra la musica en
   * marcha la deja reenganchandose en cada cuadro, que suena entrecortado. Al
   * soltar se retoma sola desde el punto nuevo.
   */
  const empezarArrastre = useCallback(() => {
    reanudarRef.current = todoRef.current && playing;
    if (reanudarRef.current) frenar();
  }, [playing, frenar]);

  const terminarArrastre = useCallback(() => {
    if (!reanudarRef.current) return;
    const video = videoRef.current;
    // Si el soltar cayo en un clip que se esta cargando, la marca queda puesta
    // y la consume el efecto de `[selectedId]` cuando haya cuadro.
    if (!video || !selected) return;
    if (video.dataset.clipId !== selected.id || video.readyState < 1) return;
    reanudarRef.current = false;
    reproducirDesdeElCabezal();
  }, [selected, reproducirDesdeElCabezal]);

  /** Corre una limpieza del almacen y cuenta en pantalla cuanto se libero. */
  const liberar = useCallback(async (accion: () => Promise<number>) => {
    const bytes = await accion();
    setListo(bytes > 0 ? `se liberaron ${formatBytes(bytes)}` : 'no había nada que liberar');
  }, []);

  /**
   * Recibe la correccion del panel del giroscopio.
   *
   * Con useCallback y sin dependencias para que su identidad no cambie: el
   * panel la tiene en un efecto, y una funcion nueva por render lo dispararia
   * en loop.
   */
  const guardarEstabilizacion = useCallback((e: Estabilizacion | null, clipId: string | null) => {
    // Solo se toca la entrada de ESE clip: el panel avisa por el clip abierto,
    // y las correcciones de los demas tienen que sobrevivir a que se cambie.
    if (!clipId) return;
    if (e) estabRef.current.set(clipId, e);
    else estabRef.current.delete(clipId);
  }, []);

  const onExport = useCallback(async () => {
    if (clips.length === 0) return;
    frenar();
    setError(null);
    setListo(null);
    setAvisos([]);

    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({
      fraction: 0,
      clipIndex: 0,
      clipCount: clips.length,
      framesWritten: 0,
      fase: 'audio',
    });

    try {
      const lista: ExportClip[] = clips.map((c) => ({
        file: c.file,
        inSeconds: c.trimIn,
        outSeconds: c.trimOut,
        speed: c.speed,
        lutConv: lutLibrary.find((l) => l.id === c.lutConvId)?.lut ?? null,
        lutLook: lutLibrary.find((l) => l.id === c.lutLookId)?.lut ?? null,
        lift: c.lift,
        gamma: c.gamma,
        gain: c.gain,
        fit: c.fit,
        panX: c.panX,
        panY: c.panY,
        volume: c.volume,
        // La de este clip, si se le dejo una preparada en la pestana clip.
        estabilizacion: estabRef.current.get(c.id) ?? null,
        hasAudio: c.info.hasAudio,
        audioCanDecode: c.info.audioCanDecode,
      }));

      /*
       * Estabilizar unos si y otros no se ve como un salto al cambiar de clip,
       * y es facil creer que el export "no la aplico". Mejor decir cuantos.
       */
      const avisosPrevios: string[] = [];
      const estabilizados = clips.filter((c) => estabRef.current.has(c.id)).length;
      if (estabilizados > 0 && estabilizados < clips.length) {
        avisosPrevios.push(
          `La estabilización se aplicó a ${estabilizados} de ${clips.length} clips: ` +
            'los demás salen sin corregir porque no se les activó en la pestaña clip.',
        );
      }

      const { blob, avisos: avisosDelExport } = await exportClips(lista, {
        preset,
        frameRate: DEFAULT_FRAME_RATE,
        music,
        layer: capa,
        onProgress: setProgress,
        signal: controller.signal,
      });

      const nombre = `predit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.mp4`;
      const via = await deliverExport(blob, nombre);
      setAvisos([...avisosPrevios, ...avisosDelExport]);
      // El montaje ya salio: ahora las copias son espacio recuperable, y el
      // panel de proyecto tiene que poder ofrecer liberarlas sin que el usuario
      // lo despliegue primero.
      proyecto.medirCopias();
      setListo(
        `${nombre} · ${formatBytes(blob.size)} · ${via === 'compartido' ? 'listo para compartir' : 'descargado'}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [clips, lutLibrary, preset, music, capa, frenar, proyecto]);

  /**
   * Al cambiar de pestana la hoja vuelve arriba. El contenedor es siempre el
   * mismo, asi que sin esto una seccion corta abre scrolleada por lo que dejo
   * la anterior.
   */
  useEffect(() => {
    cuerpoRef.current?.scrollTo(0, 0);
  }, [pestana]);

  const exportando = progress !== null;
  /** Sin clip no hay nada que tocar: los controles se ven, pero apagados. */
  const enReposo = !hayClip || exportando;
  /** Si el cabezal esta parado en un punto donde el clip se puede partir en dos. */
  const puedeCortar =
    !enReposo && selected !== null && partir(selected, currentTime, unCuadro(sourceFps)) !== null;

  /**
   * Que pestanas tienen algo puesto. Con los paneles escondidos se pierde la
   * senal de "aca hay algo cargado", y el punto de la fila la devuelve.
   */
  const marcada: Record<Pestana, boolean> = {
    clip: false,
    color: !gradeNeutro || lutConv !== null || lutLook !== null,
    musica: music !== null,
    capa: capa !== null,
    salida: false,
    proyecto: false,
  };

  return (
    <div className="app">
      {/* Las dos pantallas de arranque van encima del editor y no en su lugar:
          asi el <canvas> se monta una sola vez, con el LutRenderer colgado, y no
          hay que reconstruir el contexto WebGL al volver de re-vincular. */}
      {proyecto.fase === 'cargando' && (
        <div className="app revincular">
          <header className="barra">
            <h1>Predit</h1>
          </header>
          <p className="nota">/* abriendo lo último que estabas editando… */</p>
        </div>
      )}
      {proyecto.pendiente && (
        <ReVincular
          pendiente={proyecto.pendiente}
          biblioteca={lutLibrary}
          restaurando={proyecto.restaurando}
          error={proyecto.errorRestaurar}
          onConfirmar={(asignados) => void proyecto.revincular(asignados)}
          onDescartar={() => void proyecto.nuevo()}
        />
      )}

      {/* No hay barra de titulo: eran 46px fijos para el nombre de la app, el
          preset y la hora de guardado. El nombre no cambia nunca, y el proyecto
          con su hora ya viven en la pestana `proyecto`, que es donde se los va a
          buscar. En una pantalla de telefono esos 46px valen mas como panel. */}
      <main className="visor">
        {/* El canvas nunca se desmonta: el LutRenderer se construye una sola vez
            sobre el. En reposo lo tapa el placeholder, que ademas esconde el
            ultimo cuadro dibujado si se borran todos los clips. */}
        <div className="marco">
          <canvas
            ref={canvasRef}
            className={`lienzo${sePuedeArrastrar ? ' arrastrable' : ''}`}
            style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
            onPointerDown={onArrastreInicio}
            onPointerMove={onArrastreMovimiento}
            onPointerUp={onArrastreFin}
            onPointerCancel={onArrastreFin}
          />
          {!hayClip && <div className="lienzo-reposo" />}
          {hayClip && moviendoCapa && (
            <p className="pista">/* arrastrá para mover la capa */</p>
          )}
          {hayClip && !moviendoCapa && sePuedeReencuadrar && (
            <p className="pista">/* mové la imagen para reencuadrar */</p>
          )}
        </div>

        {/* El transporte y la barra del montaje comparten una sola fila al pie
            del visor. Van anclados al .visor y no al .marco: con el preset
            vertical el marco mide lo que el cuadro -186px de ancho en un
            telefono- y la pista quedaba usando la mitad del espacio que tenia.
            Anclada al visor la pista mide todo el ancho, y con el preset
            horizontal la fila cae en el negro de abajo del cuadro en vez de
            taparlo. */}
        {clips.length > 0 && (
          <>
            {/* El transporte flota sobre la imagen, arriba y a la izquierda de la
                barra, en vez de compartirle la fila: la pista es lo que se
                arrastra con precision y se queda con el ancho entero. */}
            <div className="transporte">
              <button
                onClick={reproducirDesdeElCabezal}
                className="principal"
                disabled={clips.length === 0 || exportando}
                title="Reproduce el montaje desde donde esta el cabezal, encadenando los clips"
              >
                {todo ? 'pausar()' : 'play()'}
              </button>
              <button
                onClick={reproducirClip}
                disabled={enReposo}
                title="Reproduce solo este clip"
              >
                {playing && !todo ? 'pausar()' : 'clip()'}
              </button>
            </div>

            <BarraLinea
              tramos={tramos}
              duracionTotal={duracionTotal}
              posicion={tiempoGlobal}
              selectedId={selectedId}
              deshabilitado={exportando}
              onSeek={irALaLinea}
              onScrubStart={empezarArrastre}
              onScrub={(s) => irALaLinea(s, { arrastrando: true })}
              onScrubEnd={terminarArrastre}
            />
          </>
        )}
        {!hayClip && (
          <div className="vacio">
            {/* El importar vive aca y no solo en la tira: sobre el visor vacio es
                donde la mano va sola, y es lo unico que hay para hacer. */}
            <label className={`importar${busy ? ' ocupado' : ''}`}>
              {busy ? 'leyendo…' : '+ importar clip'}
              <input
                type="file"
                accept="video/*"
                multiple
                disabled={busy}
                onChange={(e) => {
                  void onPickClips(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <small>Hola, edita chill, sin presion</small>
          </div>
        )}
        {/* Los dos del doble bufer. El `src` no lo pone React: quien carga que
            depende de por donde va la cadena, no del render. */}
        <video ref={videoARef} className="video-oculto" playsInline onEnded={avanzarOTerminar} />
        <video ref={videoBRef} className="video-oculto" playsInline onEnded={avanzarOTerminar} />
      </main>

      {/* La tira quedo en lo minimo: el numero de cada clip y nada mas. Con la
          tarjeta de antes -nombre, duracion y tres acciones- cuatro clips se
          comian media pantalla. El nombre y las acciones estan arriba de la barra
          de recorte, en la pestana clip, que es donde se los va a buscar. */}
      <TiraClips
        clips={clips}
        selectedId={selectedId}
        deshabilitado={exportando}
        onSelect={setSelectedId}
        onReordenar={reordenarClips}
      />

      {/* El error va afuera de la hoja porque lo pueden disparar cosas de
          cualquier pestana -importar un clip, subir un LUT, cargar la musica- y
          adentro de una sola quedaria invisible desde las demas. */}
      {error && <p className="error error-global">{error}</p>}

      <div className="hoja">
        <nav className="pestanas" role="tablist" aria-label="secciones de la edición">
          {PESTANAS.map(({ id, etiqueta }) => (
            <button
              key={id}
              id={`pestana-${id}`}
              role="tab"
              aria-selected={pestana === id}
              className={pestana === id ? 'activa' : ''}
              onClick={() => setPestana(id)}
            >
              {etiqueta}
              {marcada[id] && <span className="punto" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div
          className="hoja-cuerpo"
          ref={cuerpoRef}
          role="tabpanel"
          aria-labelledby={`pestana-${pestana}`}
        >
          {pestana === 'clip' && (
            <section className="panel">
              {/* Importar y ordenar viven arriba de la barra de recorte, que es
                  el control con el que se trabaja el clip. */}
              <div className="fila">
                <span className="comentario">
                  {selected
                    ? `clip ${String(indiceSeleccionado + 1).padStart(2, '0')} · ${selected.info.name}`
                    : 'clip'}
                </span>
                <div className="botones">
                  <label className={`chico${busy || exportando ? ' ocupado' : ''}`}>
                    {busy ? 'leyendo…' : '+ clip'}
                    <input
                      type="file"
                      accept="video/*"
                      multiple
                      disabled={busy || exportando}
                      onChange={(e) => {
                        void onPickClips(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    className="chico"
                    onClick={() => selectedId && moveClip(selectedId, -1)}
                    disabled={enReposo || indiceSeleccionado <= 0}
                    title="Adelantar este clip un lugar en el montaje"
                  >
                    ◀ mover
                  </button>
                  <button
                    className="chico"
                    onClick={() => selectedId && moveClip(selectedId, 1)}
                    disabled={enReposo || indiceSeleccionado === clips.length - 1}
                    title="Atrasar este clip un lugar en el montaje"
                  >
                    mover ▶
                  </button>
                  <button
                    className="chico"
                    onClick={cortarClip}
                    disabled={!puedeCortar}
                    title="Partir este clip en dos por donde esta el cabezal"
                  >
                    ✂ cortar
                  </button>
                  <button
                    className="chico"
                    onClick={() => selectedId && removeClip(selectedId)}
                    disabled={enReposo}
                    title="Sacar este clip del montaje"
                  >
                    × borrar
                  </button>
                </div>
              </div>

              <Recortador
                duracion={duration}
                trimIn={trimIn}
                trimOut={trimOut}
                currentTime={currentTime}
                paso={unCuadro(sourceFps)}
                centro={{
                  etiqueta: 'queda',
                  valor: `${(speed > 0 ? material / speed : material).toFixed(1)}s`,
                  nota: Math.abs(speed - 1) > 1e-6 ? `${material.toFixed(1)}s de material` : undefined,
                }}
                deshabilitado={enReposo}
                onTrim={updateSelected}
                onSeek={seek}
              />

              <div className="fila">
                <span className="comentario">velocidad</span>
                <div className="botones">
                  <button
                    className={
                      hayClip && Math.abs(speed - velocidadConforme) < 1e-6 ? 'activo chico' : 'chico'
                    }
                    onClick={() => updateSelected({ speed: velocidadConforme })}
                    disabled={enReposo}
                    title={`Cada cuadro del archivo ocupa un cuadro de la salida (${sourceFps} → ${DEFAULT_FRAME_RATE})`}
                  >
                    {DEFAULT_FRAME_RATE}p
                  </button>
                  {[0.25, 0.5, 1, 2].map((v) => (
                    <button
                      key={v}
                      className={hayClip && Math.abs(speed - v) < 1e-6 ? 'activo chico' : 'chico'}
                      onClick={() => updateSelected({ speed: v })}
                      disabled={enReposo}
                    >
                      {v}x
                    </button>
                  ))}
                </div>
              </div>

              <Deslizador
                etiqueta="sonido del clip"
                valor={volume}
                max={1}
                paso={0.01}
                onChange={(v) => updateSelected({ volume: v })}
                deshabilitado={!selected || !selected.info.hasAudio || !selected.info.audioCanDecode}
                texto={
                  !selected
                    ? 'sin clip'
                    : !selected.info.hasAudio
                      ? 'sin audio'
                      : !selected.info.audioCanDecode
                        ? 'no decodifica'
                        : Math.abs(speed - 1) > 1e-6
                          ? 'mudo (velocidad)'
                          : volume === 0
                            ? 'mudo'
                            : `${Math.round(volume * 100)}%`
                }
              />

              {selected && (
                <>
                  {!volumenAjustable && usaSuAudio && volume < 1 && (
                    <p className="aviso">
                      En el iPhone y el iPad el visor no puede bajar el volumen: lo maneja el botón del
                      teléfono. Acá el clip se escucha normal, pero en el MP4 exportado sí sale al{' '}
                      {Math.round(volume * 100)}%.
                    </p>
                  )}

                  {selected.info.hasAudio &&
                    selected.info.audioCanDecode &&
                    Math.abs(speed - 1) > 1e-6 && (
                      <p className="aviso">
                        El sonido de este clip se silencia porque tiene la velocidad cambiada: estirarlo
                        junto con la imagen lo desafina. Ponelo en 1× si querés que se escuche.
                      </p>
                    )}

                  {speed < velocidadConforme - 1e-6 && (
                    <p className="aviso">
                      A {speed}× no alcanzan los cuadros del archivo ({sourceFps} fps) y algunos se
                      repiten, así que se va a ver entrecortado. El mínimo limpio para este clip es{' '}
                      {velocidadConforme.toFixed(2)}×.
                    </p>
                  )}
                </>
              )}

              <div className="fila">
                <span className="comentario">encuadre</span>
                <div className="botones par">
                  <button
                    className={hayClip && fit === 'cover' ? 'activo chico' : 'chico'}
                    onClick={() => updateSelected({ fit: 'cover' })}
                    disabled={enReposo}
                  >
                    llenar
                  </button>
                  <button
                    className={hayClip && fit === 'contain' ? 'activo chico' : 'chico'}
                    onClick={() => updateSelected({ fit: 'contain' })}
                    disabled={enReposo}
                  >
                    bandas
                  </button>
                </div>
              </div>

              {sePuedeReencuadrar && (
                <>
                  {sobrante.overflowX > 0.001 && (
                    <Deslizador
                      etiqueta="reencuadre horizontal"
                      valor={panX}
                      min={-1}
                      max={1}
                      paso={0.01}
                      onChange={(v) => updateSelected({ panX: v })}
                      texto={panX === 0 ? 'centrado' : panX < 0 ? 'a la izquierda' : 'a la derecha'}
                    />
                  )}
                  {sobrante.overflowY > 0.001 && (
                    <Deslizador
                      etiqueta="reencuadre vertical"
                      valor={panY}
                      min={-1}
                      max={1}
                      paso={0.01}
                      onChange={(v) => updateSelected({ panY: v })}
                      texto={panY === 0 ? 'centrado' : panY < 0 ? 'hacia abajo' : 'hacia arriba'}
                    />
                  )}
                  {(panX !== 0 || panY !== 0) && (
                    <button
                      className="chico"
                      onClick={() => updateSelected({ panX: 0, panY: 0 })}
                      disabled={exportando}
                    >
                      centrar
                    </button>
                  )}
                </>
              )}

              {/* Avisos del archivo en si -audio que no decodifica, codec raro-,
                  que hablan del clip entero y no de su color. */}
              {selected?.warnings.map((w) => (
                <p key={w} className="aviso">
                  {w}
                </p>
              ))}
            </section>
          )}

          {/* Prueba de lectura del giroscopio. Va con el clip porque es una
              propiedad del archivo, como los avisos de arriba. */}
          {pestana === 'clip' && (
            <PanelGiro
              clip={selected ?? null}
              cabezal={currentTime}
              onEstabilizacion={guardarEstabilizacion}
              onAjustes={cambiarGiro}
            />
          )}

          {pestana === 'color' && (
            <section className="panel">
              {/* `crudo` vive aca y no sobre el cuadro: compara el cuadro con y
                  sin correccion, asi que solo sirve cuando hay algo de color
                  puesto -esta apagado si no hay LUT ni grade- y se lo busca
                  justo cuando se esta trabajando el color. Sobre el video
                  ocupaba un tercio de la pildora del transporte para estar
                  deshabilitado la mayor parte del tiempo. */}
              <div className="fila">
                <span className="comentario">comparar</span>
                <div className="botones">
                  <button
                    className={`chico${bypass ? ' activo' : ''}`}
                    onPointerDown={() => setBypass(true)}
                    onPointerUp={() => setBypass(false)}
                    onPointerLeave={() => setBypass(false)}
                    onPointerCancel={() => setBypass(false)}
                    disabled={(!lutConv && !lutLook && gradeNeutro) || exportando}
                    title="Manten apretado para ver el cuadro tal como salio de camara"
                  >
                    mantener para ver crudo
                  </button>
                </div>
              </div>

              <div className="fila">
                <span className="comentario">color antes del lut</span>
                <Deslizador
                  etiqueta="lift"
                  valor={lift}
                  min={LIMITES.lift.min}
                  max={LIMITES.lift.max}
                  paso={LIMITES.lift.paso}
                  onChange={(v) => updateSelected({ lift: v })}
                  texto={lift === GRADE_NEUTRO.lift ? 'neutro' : conSigno(lift)}
                  deshabilitado={enReposo}
                />
                <Deslizador
                  etiqueta="gamma"
                  valor={gamma}
                  min={LIMITES.gamma.min}
                  max={LIMITES.gamma.max}
                  paso={LIMITES.gamma.paso}
                  onChange={(v) => updateSelected({ gamma: v })}
                  texto={gamma === GRADE_NEUTRO.gamma ? 'neutro' : gamma.toFixed(2)}
                  deshabilitado={enReposo}
                />
                <Deslizador
                  etiqueta="gain"
                  valor={gain}
                  min={LIMITES.gain.min}
                  max={LIMITES.gain.max}
                  paso={LIMITES.gain.paso}
                  onChange={(v) => updateSelected({ gain: v })}
                  texto={gain === GRADE_NEUTRO.gain ? 'neutro' : gain.toFixed(2)}
                  deshabilitado={enReposo}
                />
                {!gradeNeutro && (
                  <button
                    className="chico"
                    onClick={() => updateSelected({ ...GRADE_NEUTRO })}
                    disabled={exportando}
                  >
                    restablecer color
                  </button>
                )}
              </div>

              <LutChooser
                etiqueta="lut de conversión (log → 709)"
                library={lutLibrary}
                selectedId={selected?.lutConvId ?? null}
                onSelect={(id) => updateSelected({ lutConvId: id })}
                onUpload={(f) => void onUploadLut(f, 'conv')}
                hayClip={hayClip}
                deshabilitado={enReposo}
              />

              <LutChooser
                etiqueta="lut de look (opcional)"
                library={lutLibrary}
                selectedId={selected?.lutLookId ?? null}
                onSelect={(id) => updateSelected({ lutLookId: id })}
                onUpload={(f) => void onUploadLut(f, 'look')}
                hayClip={hayClip}
                deshabilitado={enReposo}
              />

              {/* El diagnostico vive aca y no en `clip`: la curva y las primarias
                  con las que grabo la camara son el dato que se mira para elegir
                  el LUT de conversion. */}
              {selected && <Diagnostico info={selected.info} />}
            </section>
          )}

          {pestana === 'musica' && (
            <section className="panel">
              <div className="fila">
                <span className="comentario">
                  música
                  {music
                    ? ` · ${music.origen === 'clip' ? 'del clip ' : ''}${music.name} ` +
                      `(${formatDuration(music.duracionSeconds)})`
                    : ''}
                </span>
                <div className="botones">
                  <label
                    className={`chico${musicBusy || exportando || clips.length === 0 ? ' ocupado' : ''}`}
                  >
                    {musicBusy ? 'leyendo…' : music ? 'cambiar audio' : '+ audio'}
                    <input
                      type="file"
                      accept="audio/*,video/*"
                      disabled={musicBusy || exportando || clips.length === 0}
                      onChange={(e) => {
                        const archivo = e.target.files?.[0];
                        void cargarMusica(archivo, 'archivo', archivo?.name ?? 'audio');
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {selected && (
                    <button
                      className="chico"
                      disabled={!selected.info.hasAudio || musicBusy || exportando}
                      onClick={() =>
                        void cargarMusica(selected.file, 'clip', selected.info.name, selected.id)
                      }
                      title={
                        selected.info.hasAudio
                          ? 'Saca el audio de este video y lo usa como música sobre todo el proyecto'
                          : 'Este clip no tiene pista de audio'
                      }
                    >
                      usar audio del clip
                    </button>
                  )}
                  {music && (
                    <button className="chico" onClick={quitarMusica} disabled={exportando}>
                      quitar
                    </button>
                  )}
                </div>
              </div>

              {music && (
                <>
                  <Recortador
                    duracion={music.duracionSeconds}
                    trimIn={music.startInMusic}
                    trimOut={music.endInMusic}
                    currentTime={musicTime}
                    // La musica no tiene cuadros: el ajuste fino va de a una decima.
                    paso={PASO_MUSICA}
                    centro={{
                      etiqueta: 'suena',
                      valor: `${(music.endInMusic - music.startInMusic).toFixed(1)}s`,
                      nota: `${duracionTotal.toFixed(1)}s de video`,
                    }}
                    accion={
                      <button
                        className="chico"
                        disabled={exportando}
                        onClick={() => (musicPlaying ? detenerMusica() : escucharMusica(musicTime))}
                        title={musicPlaying ? 'Pausar el tema' : 'Escuchar el tema desde el cabezal'}
                      >
                        {musicPlaying ? '❚❚' : '▶'}
                      </button>
                    }
                    deshabilitado={exportando}
                    onTrim={(p) => {
                      if (p.trimIn !== undefined) updateMusic({ startInMusic: p.trimIn });
                      if (p.trimOut !== undefined) updateMusic({ endInMusic: p.trimOut });
                    }}
                    onSeek={(s) => {
                      // Tocar la barra pausa: reengancharlo en cada pixel del
                      // arrastre reiniciaria el tema decenas de veces por segundo.
                      // Para marcar escuchando estan "Entrada acá" / "Salida acá",
                      // que no mueven el cabezal.
                      if (musicPlaying) detenerMusica();
                      setMusicTime(s);
                    }}
                  />
                  <Deslizador
                    etiqueta="volumen de la música"
                    valor={music.volume}
                    max={1}
                    paso={0.01}
                    onChange={(v) => updateMusic({ volume: v })}
                    texto={music.volume === 0 ? 'muda' : `${Math.round(music.volume * 100)}%`}
                  />
                  <Deslizador
                    etiqueta="fundido de salida"
                    valor={music.fadeOut}
                    max={5}
                    paso={0.1}
                    onChange={(v) => updateMusic({ fadeOut: v })}
                    texto={music.fadeOut === 0 ? 'sin fundido' : `${music.fadeOut.toFixed(1)} s`}
                  />
                  {music.endInMusic - music.startInMusic < duracionTotal && (
                    <p className="aviso">
                      El pedazo elegido dura{' '}
                      {formatDuration(music.endInMusic - music.startInMusic)} de los{' '}
                      {formatDuration(duracionTotal)} del video: el resto queda sin música.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {pestana === 'capa' && (
            <section className="panel">
              <div className="fila">
                <span className="comentario">
                  capa{capa ? ` · ${capa.name} (${capa.width}×${capa.height})` : ''}
                </span>
                <div className="botones">
                  <label
                    className={`chico${capaBusy || exportando || clips.length === 0 ? ' ocupado' : ''}`}
                  >
                    {capaBusy ? 'leyendo…' : capa ? 'cambiar imagen' : '+ imagen'}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={capaBusy || exportando || clips.length === 0}
                      onChange={(e) => {
                        void cargarCapa(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {capa && (
                    <button className="chico" onClick={quitarCapa} disabled={exportando}>
                      quitar
                    </button>
                  )}
                </div>
              </div>

              {capa && (
                <>
                  <Recortador
                    duracion={duracionTotal}
                    trimIn={capa.startSeconds}
                    trimOut={capa.endSeconds}
                    // La capa se marca contra la LINEA DE TIEMPO entera, no contra el
                    // clip: por eso el cabezal es el segundo del montaje y no el del
                    // <video>, y por eso puede cruzar un corte.
                    currentTime={tiempoGlobal}
                    paso={unCuadro(DEFAULT_FRAME_RATE)}
                    centro={{
                      etiqueta: 'se ve',
                      valor: `${(capa.endSeconds - capa.startSeconds).toFixed(1)}s`,
                      nota: `${duracionTotal.toFixed(1)}s de video`,
                    }}
                    deshabilitado={exportando}
                    onTrim={(p) => {
                      if (p.trimIn !== undefined) updateCapa({ startSeconds: p.trimIn });
                      if (p.trimOut !== undefined) updateCapa({ endSeconds: p.trimOut });
                    }}
                    onSeek={irALaLinea}
                  />

                  <div className="fila">
                    <span className="comentario">el dedo sobre el visor mueve</span>
                    <div className="botones">
                      <button
                        className={arrastra === 'clip' ? 'activo chico' : 'chico'}
                        onClick={() => setArrastra('clip')}
                        disabled={exportando}
                        title="Arrastrar reencuadra el clip de abajo"
                      >
                        el clip
                      </button>
                      <button
                        className={arrastra === 'capa' ? 'activo chico' : 'chico'}
                        onClick={() => setArrastra('capa')}
                        disabled={exportando}
                        title="Arrastrar mueve la capa por el cuadro"
                      >
                        la capa
                      </button>
                    </div>
                  </div>

                  <Deslizador
                    etiqueta="tamaño de la capa"
                    valor={capa.scale}
                    min={0.05}
                    max={2}
                    paso={0.01}
                    onChange={(v) => updateCapa({ scale: v })}
                    texto={`${Math.round(capa.scale * 100)}%`}
                    deshabilitado={exportando}
                  />
                  <Deslizador
                    etiqueta="opacidad de la capa"
                    valor={capa.opacity}
                    max={1}
                    paso={0.01}
                    onChange={(v) => updateCapa({ opacity: v })}
                    texto={capa.opacity === 0 ? 'invisible' : `${Math.round(capa.opacity * 100)}%`}
                    deshabilitado={exportando}
                  />

                  <div className="fila">
                    <span className="comentario">animación</span>
                  </div>
                  <Deslizador
                    etiqueta="entrada"
                    valor={capa.entradaSeconds}
                    max={3}
                    paso={0.1}
                    onChange={(v) => updateCapa({ entradaSeconds: v })}
                    texto={capa.entradaSeconds === 0 ? 'de golpe' : `${capa.entradaSeconds.toFixed(1)} s`}
                    deshabilitado={exportando}
                  />
                  <Deslizador
                    etiqueta="entra desde"
                    valor={capa.scaleEntrada}
                    min={0.2}
                    max={2}
                    paso={0.05}
                    onChange={(v) => updateCapa({ scaleEntrada: v })}
                    texto={
                      capa.entradaSeconds === 0
                        ? 'sin entrada'
                        : capa.scaleEntrada === 1
                          ? 'sin zoom'
                          : `${Math.round(capa.scaleEntrada * 100)}%`
                    }
                    deshabilitado={exportando || capa.entradaSeconds === 0}
                  />
                  <Deslizador
                    etiqueta="salida"
                    valor={capa.salidaSeconds}
                    max={3}
                    paso={0.1}
                    onChange={(v) => updateCapa({ salidaSeconds: v })}
                    texto={capa.salidaSeconds === 0 ? 'de golpe' : `${capa.salidaSeconds.toFixed(1)} s`}
                    deshabilitado={exportando}
                  />
                  <Deslizador
                    etiqueta="sale hacia"
                    valor={capa.scaleSalida}
                    min={0.2}
                    max={2}
                    paso={0.05}
                    onChange={(v) => updateCapa({ scaleSalida: v })}
                    texto={
                      capa.salidaSeconds === 0
                        ? 'sin salida'
                        : capa.scaleSalida === 1
                          ? 'sin zoom'
                          : `${Math.round(capa.scaleSalida * 100)}%`
                    }
                    deshabilitado={exportando || capa.salidaSeconds === 0}
                  />

                  {capa.entradaSeconds + capa.salidaSeconds > capa.endSeconds - capa.startSeconds && (
                    <p className="aviso">
                      La entrada y la salida no entran en los{' '}
                      {(capa.endSeconds - capa.startSeconds).toFixed(1)}s que dura la capa: se acortan
                      en proporción, así que la capa se ve entera apenas un instante.
                    </p>
                  )}

                  {capa.opacity > 0 && capa.endSeconds <= capa.startSeconds && (
                    <p className="aviso">
                      La marca de salida de la capa está antes que la de entrada: no se va a ver en
                      ningún cuadro.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {pestana === 'salida' && (
            <section className="panel">
              <div className="fila">
                <span className="comentario">salida</span>
                <div className="botones">
                  {EXPORT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={p.id === preset.id ? 'activo chico' : 'chico'}
                      onClick={() => setPreset(p)}
                      disabled={exportando}
                      title={p.detalle}
                    >
                      {p.slug}
                    </button>
                  ))}
                </div>
              </div>

              <button
                className="principal grande"
                onClick={() => void onExport()}
                disabled={clips.length === 0 || exportando}
              >
                {clips.length === 0
                  ? 'exportar mp4 →'
                  : !exportando
                    ? `exportar mp4 · ${clips.length} clip${clips.length === 1 ? '' : 's'} · ${duracionTotal.toFixed(1)}s →`
                    : progress?.fase === 'audio'
                      ? 'preparando el audio…'
                      : `exportando clip ${(progress?.clipIndex ?? 0) + 1} de ${progress?.clipCount ?? clips.length} · ${Math.round((progress?.fraction ?? 0) * 100)}%`}
              </button>

              {exportando && (
                <div className="barra-progreso">
                  <div style={{ width: `${(progress?.fraction ?? 0) * 100}%` }} />
                </div>
              )}

              {listo && <p className="listo">{listo}</p>}
              {avisos.map((a) => (
                <p key={a} className="aviso">
                  {a}
                </p>
              ))}
            </section>
          )}

          {pestana === 'proyecto' && (
            <PanelProyecto
              nombre={proyecto.nombre}
              guardadoEn={proyecto.guardadoEn}
              lista={proyecto.lista}
              deshabilitado={exportando}
              hayMontaje={clips.length > 0 || music !== null || capa !== null}
              onGuardarComo={(nuevo) => void proyecto.guardarComo(nuevo)}
              onAbrir={(id) => void proyecto.abrir(id)}
              onBorrar={(id) => void proyecto.borrar(id)}
              onNuevo={() => void proyecto.nuevo()}
              onRefrescar={() => {
                proyecto.refrescar();
                proyecto.medirCopias();
              }}
              pesoCopias={proyecto.pesoCopias}
              onPurgar={() => void liberar(proyecto.purgar)}
              onLiberar={() => void liberar(proyecto.liberarEsteMontaje)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LutChooser({
  etiqueta,
  library,
  selectedId,
  onSelect,
  onUpload,
  hayClip,
  deshabilitado,
}: {
  etiqueta: string;
  library: LibraryLut[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpload: (file: File | undefined) => void;
  /** Sin clip nada esta elegido: en reposo no se marca ni "ninguno". */
  hayClip: boolean;
  deshabilitado: boolean;
}) {
  return (
    <div className="fila">
      <span className="comentario">{etiqueta}</span>
      <div className="botones">
        <button
          className={hayClip && selectedId === null ? 'activo chico' : 'chico'}
          onClick={() => onSelect(null)}
          disabled={deshabilitado}
        >
          ninguno
        </button>
        {library.map((l) => (
          <button
            key={l.id}
            className={hayClip && selectedId === l.id ? 'activo chico' : 'chico'}
            onClick={() => onSelect(l.id)}
            disabled={deshabilitado}
            title={l.name}
          >
            {l.name.replace(/\.cube$/i, '')}
          </button>
        ))}
        <label className={`chico agregar-lut${deshabilitado ? ' ocupado' : ''}`}>
          + .cube
          <input
            type="file"
            accept=".cube"
            disabled={deshabilitado}
            onChange={(e) => {
              onUpload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** Un lift de 0.10 se lee mejor como "+0.10" que como "0.10". */
function conSigno(valor: number): string {
  return valor > 0 ? '+' + valor.toFixed(2) : valor.toFixed(2);
}

/**
 * Muestra lo que el navegador entendió del archivo. Es la herramienta con la que
 * se descarta que Safari esté tocando el color antes de que llegue al LUT.
 */
function Diagnostico({ info }: { info: ClipInfo }) {
  const filas: Array<[string, string]> = [
    ['Códec', `${info.codec ?? '?'} (${info.codecString ?? '?'})`],
    [
      'Resolución',
      `${info.displayWidth}×${info.displayHeight}${info.rotation ? ` · rotado ${info.rotation}°` : ''}`,
    ],
    ['Cuadros por segundo', `${info.frameRate}${info.frameRateIsConstant ? '' : ' (variable)'}`],
    ['Duración', formatDuration(info.durationSeconds)],
    ['Tamaño', formatBytes(info.sizeBytes)],
    ['Primarios', info.colorSpace.primaries ?? 'sin etiqueta'],
    ['Transferencia', info.colorSpace.transfer ?? 'sin etiqueta'],
    ['Matriz', info.colorSpace.matrix ?? 'sin etiqueta'],
    [
      'Rango',
      info.colorSpace.fullRange === undefined
        ? 'sin etiqueta'
        : info.colorSpace.fullRange
          ? 'completo'
          : 'limitado',
    ],
    ['HDR', info.isHdr ? 'sí' : 'no'],
    ['Decodificable acá', info.canDecode ? 'sí' : 'no'],
    [
      'Audio',
      info.hasAudio
        ? `${info.audioCodec ?? '?'} · ${info.audioChannels ?? '?'} canales · ` +
          `${info.audioSampleRate ?? '?'} Hz${info.audioCanDecode ? '' : ' · no decodificable acá'}`
        : 'sin pista de audio',
    ],
  ];

  return (
    <details className="diagnostico">
      <summary className="comentario">diagnóstico del clip</summary>
      <table>
        <tbody>
          {filas.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
