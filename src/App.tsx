import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { decodeAudioRange } from './audio/decode';
import { clipAportaAudio } from './audio/mix';
import { parseCube } from './color/cube';
import { computeFit, LutRenderer, type Framing } from './color/renderer';
import {
  clipOutputDuration,
  nextId,
  type LibraryLut,
  type MusicTrack,
  type TimelineClip,
} from './edit/types';
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

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LutRenderer | null>(null);
  const bypassRef = useRef(false);
  const framingRef = useRef<Framing | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const clipsRef = useRef<TimelineClip[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const musicNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);

  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lutLibrary, setLutLibrary] = useState<LibraryLut[]>([]);
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const [musicBusy, setMusicBusy] = useState(false);
  const [preset, setPreset] = useState<ExportPreset>(DEFAULT_PRESET);
  const [currentTime, setCurrentTime] = useState(0);
  const [bypass, setBypass] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [listo, setListo] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);

  bypassRef.current = bypass;
  clipsRef.current = clips;

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

  // Al desmontar, libera los blobs que queden vivos.
  useEffect(
    () => () => {
      for (const c of clipsRef.current) URL.revokeObjectURL(c.url);
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
   * El contexto de audio se crea recien cuando el usuario toca algo: iOS no deja
   * que arranque solo, y uno creado antes del primer gesto queda suspendido.
   */
  const getAudioCtx = useCallback(() => {
    audioCtxRef.current ??= new AudioContext();
    void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const detenerMusica = useCallback(() => {
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
      if (desde < 0 || desde >= music.buffer.duration) return;

      const ctx = getAudioCtx();
      const fuente = ctx.createBufferSource();
      fuente.buffer = music.buffer;
      const ganancia = ctx.createGain();
      ganancia.gain.value = music.volume;
      fuente.connect(ganancia).connect(ctx.destination);
      fuente.start(0, desde);

      musicNodeRef.current = fuente;
      musicGainRef.current = ganancia;
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

  // Al cambiar de clip seleccionado, el visor salta a su marca de entrada.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selected) return undefined;
    setPlaying(false);
    detenerMusica();
    const target = selected.trimIn;
    const apply = () => {
      video.currentTime = target;
      setCurrentTime(target);
    };
    if (video.readyState >= 1) {
      apply();
      return undefined;
    }
    video.addEventListener('loadedmetadata', apply, { once: true });
    return () => video.removeEventListener('loadedmetadata', apply);
  }, [selectedId]);

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

  // Arrastrar sobre la imagen para reencuadrar: en el telefono es mas directo
  // que un deslizador, y es el gesto que uno espera al mover un encuadre.
  const arrastre = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const onArrastreInicio = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!sePuedeReencuadrar) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      arrastre.current = { x: e.clientX, y: e.clientY, panX, panY };
    },
    [sePuedeReencuadrar, panX, panY],
  );

  const onArrastreMovimiento = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const inicio = arrastre.current;
      if (!inicio) return;
      const rect = e.currentTarget.getBoundingClientRect();
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
    [sobrante, updateSelected],
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
        renderer.draw(video, framing, bypassRef.current);
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

  // Al reproducir, frena en la marca de salida en vez de seguir hasta el final.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    const check = () => {
      if (video.currentTime >= trimOut) {
        video.pause();
        video.currentTime = trimIn;
        setPlaying(false);
        detenerMusica();
      }
    };
    const id = setInterval(check, 60);
    return () => clearInterval(id);
  }, [playing, trimIn, trimOut, detenerMusica]);

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
          volume: 0.8,
          fadeIn: 0,
          fadeOut: 1.5,
        });
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
  }, [detenerMusica]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < trimIn || video.currentTime >= trimOut) video.currentTime = trimIn;
      void video.play();
      setPlaying(true);
      arrancarMusica(offsetSeleccionado + (video.currentTime - trimIn) / speed);
    } else {
      video.pause();
      setPlaying(false);
      detenerMusica();
    }
  }, [trimIn, trimOut, speed, offsetSeleccionado, arrancarMusica, detenerMusica]);

  const onExport = useCallback(async () => {
    if (clips.length === 0) return;
    videoRef.current?.pause();
    setPlaying(false);
    detenerMusica();
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
  }, [clips, lutLibrary, preset, music, detenerMusica]);

  const exportando = progress !== null;

  return (
    <div className="app">
      <header className="barra">
        <h1>Predit</h1>
        <span className="subtitulo">{preset.nombre}</span>
      </header>

      <main className="visor">
        <canvas
          ref={canvasRef}
          className={`lienzo${sePuedeReencuadrar ? ' arrastrable' : ''}`}
          style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
          onPointerDown={onArrastreInicio}
          onPointerMove={onArrastreMovimiento}
          onPointerUp={onArrastreFin}
          onPointerCancel={onArrastreFin}
        />
        {selected && sePuedeReencuadrar && (
          <p className="pista">Arrastrá la imagen para reencuadrar</p>
        )}
        {!selected && (
          <p className="vacio">
            Importá un clip para empezar.
            <br />
            <small>Proxy de la FX6, GoPro o DJI. Los MXF no se pueden abrir en el teléfono.</small>
          </p>
        )}
        <video
          ref={videoRef}
          src={selected?.url}
          className="video-oculto"
          playsInline
          onEnded={() => {
            setPlaying(false);
            detenerMusica();
          }}
        />
      </main>

      {selected && (
        <div className="controles">
          <button onClick={togglePlay} className="principal" disabled={exportando}>
            {playing ? 'Pausa' : 'Reproducir'}
          </button>
          <button
            className={bypass ? 'activo' : ''}
            onPointerDown={() => setBypass(true)}
            onPointerUp={() => setBypass(false)}
            onPointerLeave={() => setBypass(false)}
            disabled={(!lutConv && !lutLook) || exportando}
          >
            Sin LUT
          </button>
        </div>
      )}

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
          {busy ? 'Leyendo…' : '+ Clip'}
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

      {selected && (
        <section className="panel">
          <Deslizador
            etiqueta="Posición"
            valor={currentTime}
            max={duration}
            onChange={seek}
            texto={`${formatDuration(currentTime)} / ${formatDuration(duration)}`}
          />
          <Deslizador
            etiqueta="Entrada"
            valor={trimIn}
            max={duration}
            onChange={(v) => {
              const nuevo = Math.min(v, trimOut - 1 / sourceFps);
              updateSelected({ trimIn: nuevo });
              seek(nuevo);
            }}
            texto={formatDuration(trimIn)}
          />
          <Deslizador
            etiqueta="Salida"
            valor={trimOut}
            max={duration}
            onChange={(v) => {
              const nuevo = Math.max(v, trimIn + 1 / sourceFps);
              updateSelected({ trimOut: nuevo });
              seek(nuevo);
            }}
            texto={formatDuration(trimOut)}
          />

          <div className="fila">
            <span className="etiqueta">Velocidad</span>
            <div className="botones">
              <button
                className={Math.abs(speed - velocidadConforme) < 1e-6 ? 'activo chico' : 'chico'}
                onClick={() => updateSelected({ speed: velocidadConforme })}
                disabled={exportando}
                title={`Cada cuadro del archivo ocupa un cuadro de la salida (${sourceFps} → ${DEFAULT_FRAME_RATE})`}
              >
                Conformar a {DEFAULT_FRAME_RATE}p
              </button>
              {[0.25, 0.5, 1, 2].map((v) => (
                <button
                  key={v}
                  className={Math.abs(speed - v) < 1e-6 ? 'activo chico' : 'chico'}
                  onClick={() => updateSelected({ speed: v })}
                  disabled={exportando}
                >
                  {v}×
                </button>
              ))}
            </div>
          </div>

          <Deslizador
            etiqueta="Sonido del clip"
            valor={volume}
            max={1}
            paso={0.01}
            onChange={(v) => updateSelected({ volume: v })}
            deshabilitado={!selected.info.hasAudio || !selected.info.audioCanDecode}
            texto={
              !selected.info.hasAudio
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

          {selected.info.hasAudio && selected.info.audioCanDecode && Math.abs(speed - 1) > 1e-6 && (
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

          <div className="fila">
            <span className="etiqueta">Encuadre</span>
            <div className="botones">
              <button
                className={fit === 'cover' ? 'activo chico' : 'chico'}
                onClick={() => updateSelected({ fit: 'cover' })}
                disabled={exportando}
              >
                Llenar y recortar
              </button>
              <button
                className={fit === 'contain' ? 'activo chico' : 'chico'}
                onClick={() => updateSelected({ fit: 'contain' })}
                disabled={exportando}
              >
                Entero con bandas
              </button>
            </div>
          </div>

          {sePuedeReencuadrar && (
            <>
              {sobrante.overflowX > 0.001 && (
                <Deslizador
                  etiqueta="Reencuadre horizontal"
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
                  etiqueta="Reencuadre vertical"
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
                  Centrar
                </button>
              )}
            </>
          )}

          <LutChooser
            etiqueta="LUT de conversión (log → 709)"
            library={lutLibrary}
            selectedId={selected.lutConvId}
            onSelect={(id) => updateSelected({ lutConvId: id })}
            onUpload={(f) => void onUploadLut(f, 'conv')}
            deshabilitado={exportando}
          />
          <LutChooser
            etiqueta="LUT de look (opcional)"
            library={lutLibrary}
            selectedId={selected.lutLookId}
            onSelect={(id) => updateSelected({ lutLookId: id })}
            onUpload={(f) => void onUploadLut(f, 'look')}
            deshabilitado={exportando}
          />

          {selected.warnings.map((w) => (
            <p key={w} className="aviso">
              {w}
            </p>
          ))}

          <Diagnostico info={selected.info} />
        </section>
      )}

      {clips.length > 0 && (
        <section className="panel">
          <div className="fila">
            <span className="etiqueta">
              Música
              {music
                ? ` · ${music.origen === 'clip' ? 'del clip ' : ''}${music.name} ` +
                  `(${formatDuration(music.duracionSeconds)})`
                : ''}
            </span>
            <div className="botones">
              <label className={`chico${musicBusy || exportando ? ' ocupado' : ''}`}>
                {musicBusy ? 'Leyendo…' : music ? 'Cambiar audio' : '+ Audio'}
                <input
                  type="file"
                  accept="audio/*,video/*"
                  disabled={musicBusy || exportando}
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
                  Usar el audio de este clip
                </button>
              )}
              {music && (
                <button className="chico" onClick={quitarMusica} disabled={exportando}>
                  Quitar
                </button>
              )}
            </div>
          </div>

          {music && (
            <>
              <Deslizador
                etiqueta="Volumen de la música"
                valor={music.volume}
                max={1}
                paso={0.01}
                onChange={(v) => updateMusic({ volume: v })}
                texto={music.volume === 0 ? 'muda' : `${Math.round(music.volume * 100)}%`}
              />
              <Deslizador
                etiqueta="Empieza en"
                valor={music.startInMusic}
                max={Math.max(0, music.duracionSeconds - 1)}
                onChange={(v) => updateMusic({ startInMusic: v })}
                texto={formatDuration(music.startInMusic)}
              />
              <Deslizador
                etiqueta="Fundido de salida"
                valor={music.fadeOut}
                max={5}
                paso={0.1}
                onChange={(v) => updateMusic({ fadeOut: v })}
                texto={music.fadeOut === 0 ? 'sin fundido' : `${music.fadeOut.toFixed(1)} s`}
              />
              {music.duracionSeconds - music.startInMusic < duracionTotal && (
                <p className="aviso">
                  El tema alcanza para {formatDuration(music.duracionSeconds - music.startInMusic)}{' '}
                  de los {formatDuration(duracionTotal)} del video: el resto queda sin música.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {clips.length > 0 && (
        <section className="panel">
          <div className="fila">
            <span className="etiqueta">Salida</span>
            <div className="botones">
              {EXPORT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={p.id === preset.id ? 'activo chico' : 'chico'}
                  onClick={() => setPreset(p)}
                  disabled={exportando}
                  title={p.detalle}
                >
                  {p.nombre}
                </button>
              ))}
            </div>
          </div>

          <button className="principal grande" onClick={() => void onExport()} disabled={exportando}>
            {!exportando
              ? `Exportar MP4 · ${clips.length} clip${clips.length === 1 ? '' : 's'} · ${duracionTotal.toFixed(1)} s`
              : progress?.fase === 'audio'
                ? 'Preparando el audio…'
                : `Exportando clip ${(progress?.clipIndex ?? 0) + 1} de ${progress?.clipCount ?? clips.length} · ${Math.round((progress?.fraction ?? 0) * 100)}%`}
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
      )}

      {clips.length === 0 && error && (
        <section className="panel">
          <p className="error">{error}</p>
        </section>
      )}
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
        {index + 1}
        {clip.warnings.length > 0 && (
          <span className="aviso-badge" title={clip.warnings.join(' ')}>
            {' '}
            ⚠
          </span>
        )}
      </span>
      <span className="nombre">{clip.info.name}</span>
      <span className="duracion">{formatDuration(clipOutputDuration(clip))}</span>
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
  deshabilitado,
}: {
  etiqueta: string;
  library: LibraryLut[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpload: (file: File | undefined) => void;
  deshabilitado: boolean;
}) {
  return (
    <div className="fila">
      <span className="etiqueta">{etiqueta}</span>
      <div className="botones">
        <button
          className={selectedId === null ? 'activo chico' : 'chico'}
          onClick={() => onSelect(null)}
          disabled={deshabilitado}
        >
          Ninguno
        </button>
        {library.map((l) => (
          <button
            key={l.id}
            className={selectedId === l.id ? 'activo chico' : 'chico'}
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
      <span className="etiqueta">{etiqueta}</span>
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
      <summary>Diagnóstico del clip</summary>
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
