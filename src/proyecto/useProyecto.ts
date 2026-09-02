/**
 * El guardado visto desde el editor: autoguardado, proyectos con nombre y la
 * sesion que sobrevive a un cierre inesperado.
 *
 * El hook no toca el estado de la edicion: lo lee para serializarlo y, cuando
 * hay que restaurar, se lo devuelve entero a `App` por `onRestaurar`. Asi la
 * unica fuente de verdad del montaje sigue siendo `App`, y esto es nada mas la
 * capa que lo escribe en disco.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { nextId, type LibraryLut, type MusicTrack, type OverlayLayer, type TimelineClip } from '../edit/types';
import type { ExportPreset } from '../export/presets';
import {
  borrarProyecto,
  borrarSesion,
  guardarProyecto,
  guardarSesion,
  leerLuts,
  leerProyecto,
  leerSesion,
  listarProyectos,
  marcarCierreLimpio,
  olvidarCierreLimpio,
  pedirPersistencia,
  tomarCierreLimpio,
} from './almacen';
import {
  mismoContenido,
  serializarProyecto,
  NOMBRE_SIN_TITULO,
  type EstadoProyecto,
  type ProyectoDoc,
  type ResumenProyecto,
} from './esquema';
import { reconstruir, type EstadoRestaurado } from './restaurar';

/**
 * Cuanto espera el autoguardado despues del ultimo cambio.
 *
 * Corto porque escribir cuesta nada (un JSON de pocos KB), pero no cero: mover
 * un deslizador dispara decenas de cambios por segundo y no tiene sentido
 * escribir en cada uno.
 */
const ESPERA_MS = 800;

/** En que esta la app: editando, o pidiendo los archivos de un proyecto. */
export type FaseProyecto = 'cargando' | 'editando' | 'revinculando';

/**
 * Por que estamos en la pantalla de re-vinculacion. Solo 'crash' muestra el
 * cartel: los otros dos son continuaciones normales del trabajo.
 */
export type MotivoRevinculacion = 'sesion' | 'crash' | 'abrir';

export interface Pendiente {
  doc: ProyectoDoc;
  motivo: MotivoRevinculacion;
}

interface Opciones {
  clips: TimelineClip[];
  music: MusicTrack | null;
  capa: OverlayLayer | null;
  preset: ExportPreset;
  selectedId: string | null;
  biblioteca: LibraryLut[];
  /** Deja el montaje restaurado en el editor. */
  onRestaurar: (restaurado: EstadoRestaurado) => void;
  /** Vacia el editor, como recien abierta la app. */
  onLimpiar: () => void;
  /** Los LUTs que estaban guardados de sesiones anteriores. */
  onBiblioteca: (luts: LibraryLut[]) => void;
}

export interface Proyecto {
  fase: FaseProyecto;
  pendiente: Pendiente | null;
  nombre: string;
  /** Cuando se guardo por ultima vez, o null si todavia no se guardo nada. */
  guardadoEn: number | null;
  lista: ResumenProyecto[];
  /** Vuelve a leer la lista, para cuando el usuario la abre. */
  refrescar: () => void;
  restaurando: boolean;
  errorRestaurar: string | null;
  guardarComo: (nombre: string) => Promise<void>;
  abrir: (id: string) => Promise<void>;
  borrar: (id: string) => Promise<void>;
  nuevo: () => Promise<void>;
  /** Entra al editor con los archivos que el usuario acaba de elegir. */
  revincular: (asignados: Map<string, File>) => Promise<void>;
}

/** Un proyecto sin nada adentro se puede abrir sin pedirle archivos a nadie. */
function necesitaArchivos(doc: ProyectoDoc): boolean {
  return doc.clips.length > 0 || doc.music !== null || doc.capa !== null;
}

export function useProyecto(opciones: Opciones): Proyecto {
  const { clips, music, capa, preset, selectedId, biblioteca } = opciones;

  const [id, setId] = useState(() => nextId('proy'));
  const [nombre, setNombre] = useState(NOMBRE_SIN_TITULO);
  const [guardadoEn, setGuardadoEn] = useState<number | null>(null);
  const [fase, setFase] = useState<FaseProyecto>('cargando');
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const [lista, setLista] = useState<ResumenProyecto[]>([]);
  const [restaurando, setRestaurando] = useState(false);
  const [errorRestaurar, setErrorRestaurar] = useState<string | null>(null);

  /** Lo ultimo que se escribio, para no volver a escribir lo mismo. */
  const ultimoRef = useRef<ProyectoDoc | null>(null);
  /** Si el proyecto ya tiene nombre propio, y por lo tanto vive en la lista. */
  const conNombreRef = useRef(false);
  /** Las funciones que corren fuera de React (el `pagehide`) leen de aca. */
  const estadoRef = useRef<EstadoProyecto>({ id, nombre, clips, music, capa, preset, selectedId });
  estadoRef.current = { id, nombre, clips, music, capa, preset, selectedId };
  const bibliotecaRef = useRef(biblioteca);
  bibliotecaRef.current = biblioteca;
  const opcionesRef = useRef(opciones);
  opcionesRef.current = opciones;
  const pendienteRef = useRef<Pendiente | null>(pendiente);
  pendienteRef.current = pendiente;

  const refrescarLista = useCallback(async () => {
    setLista(await listarProyectos());
  }, []);

  /**
   * Escribe la sesion, y el proyecto tambien si ya tiene nombre.
   *
   * La sesion se escribe siempre: es la red que atrapa el cierre inesperado,
   * aunque el montaje todavia se llame "sin titulo".
   */
  const escribir = useCallback(async () => {
    const doc = serializarProyecto(estadoRef.current);
    // Un editor vacio y sin nombre no es nada que valga la pena guardar, y
    // ademas resucitaria la sesion que se acaba de descartar.
    if (!conNombreRef.current && !necesitaArchivos(doc)) return;
    ultimoRef.current = doc;
    await guardarSesion(doc);
    // La lista no se refresca aca a proposito: esto corre cada vez que la mano
    // se queda quieta, y releer todos los proyectos para actualizar una fecha
    // que ni siquiera esta en pantalla seria trabajo al pedo. La lista se
    // refresca sola cuando el usuario la abre.
    if (conNombreRef.current) await guardarProyecto(doc);
    setGuardadoEn(doc.actualizado);
  }, []);

  // Al abrir: la biblioteca de LUTs (que es global y no de ningun proyecto) y
  // la sesion que haya quedado de la vez anterior.
  useEffect(() => {
    let vivo = true;
    // La marca se levanta antes que nada y vale para este arranque solo: si la
    // app se cae mas tarde, ya no esta y el corte se ve como corte.
    const cerroBien = tomarCierreLimpio();
    void (async () => {
      void pedirPersistencia();
      const [luts, sesion] = await Promise.all([leerLuts(), leerSesion()]);
      if (!vivo) return;

      const biblioteca = luts.map((l) => ({ id: l.id, name: l.name, lut: l.lut }));
      if (biblioteca.length > 0) opcionesRef.current.onBiblioteca(biblioteca);
      void refrescarLista();

      if (!sesion) {
        setFase('editando');
        return;
      }
      setId(sesion.doc.id);
      setNombre(sesion.doc.nombre);
      conNombreRef.current = sesion.doc.nombre !== NOMBRE_SIN_TITULO;
      setGuardadoEn(sesion.doc.actualizado);

      if (!necesitaArchivos(sesion.doc)) {
        // Sin material que pedir se entra derecho, pero igual hay que aplicar
        // el documento: ahi vive la salida elegida, que si no se perderia.
        opcionesRef.current.onRestaurar(await reconstruir(sesion.doc, new Map(), biblioteca));
        ultimoRef.current = sesion.doc;
        setFase('editando');
        return;
      }
      setPendiente({ doc: sesion.doc, motivo: cerroBien ? 'sesion' : 'crash' });
      setFase('revinculando');
    })();
    return () => {
      vivo = false;
    };
  }, [refrescarLista]);

  // El autoguardado. Se re-dispara con cada cambio del montaje y espera a que
  // la mano se quede quieta.
  useEffect(() => {
    if (fase !== 'editando') return;
    const doc = serializarProyecto(estadoRef.current);
    if (mismoContenido(doc, ultimoRef.current)) return;
    const timer = setTimeout(() => void escribir(), ESPERA_MS);
    return () => clearTimeout(timer);
  }, [fase, clips, music, capa, preset, selectedId, nombre, escribir]);

  /**
   * Los dos momentos en que el navegador se puede llevar la pagina.
   *
   * `visibilitychange` es el que importa para no perder trabajo: cuando la app
   * se va al fondo puede no volver nunca, y ahi todavia esta viva para terminar
   * de escribir, asi que se guarda sin esperar el debounce.
   *
   * `pagehide` solo deja la marca de cierre limpio, que es sincronica. Escribir
   * el montaje ahi no serviria: la pagina se muere antes de que la transaccion
   * de IndexedDB llegue a confirmar.
   *
   * `pageshow` levanta la marca al volver: la pagina que se fue al bfcache y
   * despues vuelve no se cerro, y si se cae mas tarde tiene que contar como
   * corte.
   */
  useEffect(() => {
    if (fase !== 'editando') return;
    const alEsconder = () => {
      if (document.visibilityState === 'hidden') void escribir();
    };
    const alIrse = () => marcarCierreLimpio();
    const alVolver = () => olvidarCierreLimpio();
    document.addEventListener('visibilitychange', alEsconder);
    window.addEventListener('pagehide', alIrse);
    window.addEventListener('pageshow', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alEsconder);
      window.removeEventListener('pagehide', alIrse);
      window.removeEventListener('pageshow', alVolver);
    };
  }, [fase, escribir]);

  const guardarComo = useCallback(
    async (nuevoNombre: string) => {
      const limpio = nuevoNombre.trim() || NOMBRE_SIN_TITULO;
      setNombre(limpio);
      conNombreRef.current = limpio !== NOMBRE_SIN_TITULO;
      const doc = serializarProyecto({ ...estadoRef.current, nombre: limpio });
      ultimoRef.current = doc;
      await guardarSesion(doc);
      await guardarProyecto(doc);
      setGuardadoEn(doc.actualizado);
      await refrescarLista();
    },
    [refrescarLista],
  );

  const abrir = useCallback(async (proyectoId: string) => {
    const doc = await leerProyecto(proyectoId);
    if (!doc) return;
    // Se vacia el editor antes de tapar la pantalla: si no, el montaje anterior
    // se queda atras sonando mientras el usuario elige los archivos del nuevo.
    opcionesRef.current.onLimpiar();
    setId(doc.id);
    setNombre(doc.nombre);
    conNombreRef.current = doc.nombre !== NOMBRE_SIN_TITULO;
    setGuardadoEn(doc.actualizado);
    ultimoRef.current = null;
    setErrorRestaurar(null);
    if (!necesitaArchivos(doc)) {
      opcionesRef.current.onRestaurar(await reconstruir(doc, new Map(), bibliotecaRef.current));
      ultimoRef.current = doc;
      setPendiente(null);
      setFase('editando');
      return;
    }
    setPendiente({ doc, motivo: 'abrir' });
    setFase('revinculando');
  }, []);

  /**
   * Vuelve al editor vacio y tira la sesion guardada.
   *
   * Es lo mismo empezar un proyecto nuevo que descartar una sesion cortada: en
   * los dos casos se abandona lo que habia sin haberlo abierto.
   */
  const nuevo = useCallback(async () => {
    opcionesRef.current.onLimpiar();
    setId(nextId('proy'));
    setNombre(NOMBRE_SIN_TITULO);
    conNombreRef.current = false;
    ultimoRef.current = null;
    setGuardadoEn(null);
    setPendiente(null);
    setErrorRestaurar(null);
    setFase('editando');
    await borrarSesion();
  }, []);

  const borrar = useCallback(
    async (proyectoId: string) => {
      await borrarProyecto(proyectoId);
      await refrescarLista();
    },
    [refrescarLista],
  );

  const revincular = useCallback(async (asignados: Map<string, File>) => {
    const actual = pendienteRef.current;
    if (!actual) return;
    setRestaurando(true);
    setErrorRestaurar(null);
    try {
      const restaurado = await reconstruir(actual.doc, asignados, bibliotecaRef.current);
      opcionesRef.current.onRestaurar(restaurado);
      setPendiente(null);
      setFase('editando');
    } catch (e) {
      setErrorRestaurar(e instanceof Error ? e.message : String(e));
    } finally {
      setRestaurando(false);
    }
  }, []);

  return {
    fase,
    pendiente,
    nombre,
    guardadoEn,
    lista,
    refrescar: () => void refrescarLista(),
    restaurando,
    errorRestaurar,
    guardarComo,
    abrir,
    borrar,
    nuevo,
    revincular,
  };
}
