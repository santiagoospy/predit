import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { decodeAudioRange } from './audio/decode';
import { clipAportaAudio } from './audio/mix';
import { parseCube } from './color/cube';
import { computeFit, LutRenderer, type Framing } from './color/renderer';
import { Recortador } from './edit/Recortador';
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

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LutRenderer | null>(null);
  const bypassRef = useRef(false);
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
  /**
   * Un segundo puntual DENTRO del clip al que estamos saltando. Lo deja puesto
   * un salto desde la barra de la capa, que habla en tiempo de linea de tiempo
   * y puede caer en un clip que todavia no es el seleccionado.
   */
  const saltoRef = useRef<number | null>(null);
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

  bypassRef.current = bypass;
  clipsRef.current = clips;
  // El bucle que mueve el cabezal lee de aca, no de la clausura: si no, marcar
  // la salida mientras suena el tema no frenaria hasta la salida vieja.
  musicRef.current = music;

  const selected = clips.find((c) => c.id === selectedId) ?? null;
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
    const apply = () => {
      video.currentTime = target;
      setCurrentTime(target);
      if (enCadena) {
        void video.play();
        setPlaying(true);
      }
    };
    if (video.readyState >= 1) {
      apply();
      return undefined;
    }
    video.addEventListener('loadedmetadata', apply, { once: true });
    return () => video.removeEventListener('loadedmetadata', apply);
  }, [selectedId]);

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
  }, [usaSuAudio, volume, speed, selectedId]);

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

  // Bucle de dibujo: cada cuadro que entrega el decodificador pasa por el shader.
  useEffect(() => {
    const video = videoRef.current;
    const renderer = rendererRef.current;
    if (!video || !renderer || !selected) return;

    renderer.resize(previewSize.width, previewSize.height);

    let stop = false;
    let handle = 0;

    const paint = () => {
      const framing = framingRef.current;
      if (stop || !framing || video.readyState < 2) return;
      try {
        renderer.clear();
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

    return () => {
      stop = true;
      cancelAnimationFrame(handle);
    };
  }, [selected, previewSize]);

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
        video.pause();
        avanceRef.current = true;
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
  }, [clips, selectedId, trimIn, detenerMusica]);

  // Al reproducir, frena en la marca de salida en vez de seguir hasta el final.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    const check = () => {
      if (video.currentTime >= trimOut) avanzarOTerminar();
    };
    const id = setInterval(check, 60);
    return () => clearInterval(id);
  }, [playing, trimOut, avanzarOTerminar]);

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
    (segundos: number) => {
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
          if (c.id === selectedId) {
            video.currentTime = dentro;
            setCurrentTime(dentro);
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
    [clips, selectedId],
  );

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
        nuevos.push({
          id: nextId('clip'),
          file,
          url: URL.createObjectURL(file),
          info,
          warnings: clipWarnings(info),
          lutConvId: null,
          lutLookId: null,
          fit: 'cover',
          panX: 0,
          panY: 0,
          speed: 1,
          trimIn: 0,
          trimOut: info.durationSeconds,
          volume: 1,
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
    setClips((prev) => {
      const victima = prev.find((c) => c.id === id);
      if (victima) URL.revokeObjectURL(victima.url);
      return prev.filter((c) => c.id !== id);
    });
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
    async (file: File | undefined, origen: 'archivo' | 'clip', nombre: string) => {
      if (!file) return;
      setError(null);
      setListo(null);
      setMusicBusy(true);
      detenerMusica();
      try {
        const buffer = await decodeAudioRange(file);
        setMusic({
          id: nextId('mus'),
          name: nombre,
          origen,
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
        // La imagen anterior se libera a mano: un ImageBitmap retiene su buffer
        // hasta que se lo cierra, y cambiar de capa varias veces los acumularia.
        const anterior = capaRef.current;
        setCapa({
          id: nextId('capa'),
          name: file.name,
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
   * El play general: la linea de tiempo entera desde el primer clip, encadenando
   * uno tras otro. Es la forma de ver como quedo el montaje sin exportar.
   */
  const reproducirTodo = useCallback(() => {
    const video = videoRef.current;
    const primero = clips[0];
    if (!video || !primero) return;
    if (todoRef.current) {
      frenar();
      return;
    }

    todoRef.current = true;
    setTodo(true);
    // La linea de tiempo arranca en cero, asi que la musica tambien.
    arrancarMusica(0);

    if (primero.id === selectedId) {
      // Ya estamos parados ahi: cambiar la seleccion no dispararia ningun efecto.
      video.currentTime = primero.trimIn;
      void video.play();
      setPlaying(true);
    } else {
      avanceRef.current = true;
      setSelectedId(primero.id);
    }
  }, [clips, selectedId, arrancarMusica, frenar]);

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
        fit: c.fit,
        panX: c.panX,
        panY: c.panY,
        volume: c.volume,
        hasAudio: c.info.hasAudio,
        audioCanDecode: c.info.audioCanDecode,
      }));

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
      setAvisos(avisosDelExport);
      setListo(
        `${nombre} · ${formatBytes(blob.size)} · ${via === 'compartido' ? 'listo para compartir' : 'descargado'}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [clips, lutLibrary, preset, music, capa, frenar]);

  const exportando = progress !== null;
  /** Sin clip no hay nada que tocar: los controles se ven, pero apagados. */
  const enReposo = !hayClip || exportando;

  return (
    <div className="app">
      <header className="barra">
        <h1>Predit</h1>
        <span className="subtitulo">{preset.slug}</span>
      </header>

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
        </div>
        {hayClip && moviendoCapa && (
          <p className="pista">/* arrastrá para mover la capa */</p>
        )}
        {hayClip && !moviendoCapa && sePuedeReencuadrar && (
          <p className="pista">/* arrastrá la imagen para reencuadrar */</p>
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
            <small>Proxy de la FX6, GoPro o DJI. Los MXF no se pueden abrir en el teléfono.</small>
          </div>
        )}
        <video
          ref={videoRef}
          src={selected?.url}
          className="video-oculto"
          playsInline
          onEnded={avanzarOTerminar}
        />
      </main>

      <div className="controles">
        <button
          onClick={reproducirTodo}
          className="principal"
          disabled={clips.length === 0 || exportando}
          title="Reproduce la linea de tiempo entera, encadenando los clips"
        >
          {todo ? 'pausar()' : 'todo()'}
        </button>
        <button onClick={reproducirClip} disabled={enReposo} title="Reproduce solo este clip">
          {playing && !todo ? 'pausar()' : 'clip()'}
        </button>
        <button
          className={bypass ? 'activo' : ''}
          onPointerDown={() => setBypass(true)}
          onPointerUp={() => setBypass(false)}
          onPointerLeave={() => setBypass(false)}
          disabled={(!lutConv && !lutLook) || exportando}
        >
          sin lut
        </button>
      </div>

      <section className="tira">
        {clips.map((c, i) => (
          <ClipCard
            key={c.id}
            clip={c}
            index={i}
            total={clips.length}
            activo={c.id === selectedId}
            deshabilitado={exportando}
            onSelect={() => setSelectedId(c.id)}
            onRemove={() => removeClip(c.id)}
            onMoveLeft={() => moveClip(c.id, -1)}
            onMoveRight={() => moveClip(c.id, 1)}
          />
        ))}
        <label className={`tira-agregar${busy ? ' ocupado' : ''}`}>
          {busy ? 'leyendo…' : '+ clip'}
          <input
            type="file"
            accept="video/*"
            multiple
            onChange={(e) => {
              void onPickClips(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </section>

      <section className="panel">
        <Recortador
          duracion={duration}
          trimIn={trimIn}
          trimOut={trimOut}
          currentTime={currentTime}
          paso={unCuadro(sourceFps)}
          nombrePaso="un cuadro"
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

        {selected && (
          <>
            {selected.warnings.map((w) => (
              <p key={w} className="aviso">
                {w}
              </p>
            ))}
            <Diagnostico info={selected.info} />
          </>
        )}
      </section>

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
                onClick={() => void cargarMusica(selected.file, 'clip', selected.info.name)}
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
              nombrePaso="una décima"
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
              currentTime={tiempoEnLaLinea(offsetSeleccionado, currentTime, trimIn, speed)}
              paso={unCuadro(DEFAULT_FRAME_RATE)}
              nombrePaso="un cuadro"
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
        {error && <p className="error">{error}</p>}
      </section>

    </div>
  );
}

function ClipCard({
  clip,
  index,
  total,
  activo,
  deshabilitado,
  onSelect,
  onRemove,
  onMoveLeft,
  onMoveRight,
}: {
  clip: TimelineClip;
  index: number;
  total: number;
  activo: boolean;
  deshabilitado: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}) {
  return (
    <div className={`tira-clip${activo ? ' activo' : ''}`} onClick={onSelect}>
      <span className="num">
        {String(index + 1).padStart(2, '0')}
        {clip.warnings.length > 0 && (
          <span className="aviso-badge" title={clip.warnings.join(' ')}>
            {' '}
            ⚠
          </span>
        )}
      </span>
      <span className="nombre">
        {clip.info.name} · {formatDuration(clipOutputDuration(clip))}
      </span>
      <div className="acciones">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMoveLeft();
          }}
          disabled={index === 0 || deshabilitado}
        >
          ◀
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          disabled={deshabilitado}
        >
          ×
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMoveRight();
          }}
          disabled={index === total - 1 || deshabilitado}
        >
          ▶
        </button>
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

function Deslizador({
  etiqueta,
  valor,
  min = 0,
  max,
  paso,
  onChange,
  texto,
  deshabilitado,
}: {
  etiqueta: string;
  valor: number;
  min?: number;
  max: number;
  paso?: number;
  onChange: (valor: number) => void;
  texto: string;
  deshabilitado?: boolean;
}) {
  return (
    <label className={`deslizador${deshabilitado ? ' apagado' : ''}`}>
      <span className="comentario">{etiqueta}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={paso ?? 0.01}
        value={valor}
        disabled={deshabilitado ?? false}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="valor">{texto}</span>
    </label>
  );
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
