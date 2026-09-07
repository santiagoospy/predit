/**
 * Donde viven los proyectos: IndexedDB, a mano y sin dependencias.
 *
 * Es IndexedDB y no localStorage por dos razones. Una, los LUTs: un `.cube`
 * parseado es un Float32Array de medio mega y localStorage solo guarda texto,
 * asi que habria que pasarlo a base64 y engordarlo un tercio. Dos, localStorage
 * es sincronico y bloquea el hilo de dibujo, que en esta app esta ocupado
 * pintando video.
 *
 * Todo lo de aca falla en silencio y devuelve null si el navegador no deja
 * abrir la base (Safari en navegacion privada, por ejemplo): guardar es una red
 * de seguridad, y no poder tenderla no puede romper la edicion.
 */

import type { Lut3D } from '../color/cube';
import {
  claveMedio,
  huellaDe,
  mediosDe,
  resumir,
  type ProyectoDoc,
  type ResumenProyecto,
} from './esquema';

const DB_NOMBRE = 'predit';
const DB_VERSION = 2;

const PROYECTOS = 'proyectos';
const LUTS = 'luts';
const SESION = 'sesion';
const MEDIOS = 'medios';

/** La sesion es una sola: siempre se pisa la misma fila. */
const CLAVE_SESION = 'actual';

/** Un LUT de la biblioteca, guardado aparte de los proyectos que lo usan. */
export interface LutGuardado {
  id: string;
  name: string;
  lut: Lut3D;
}

/** El ultimo estado conocido del editor. */
export interface SesionGuardada {
  doc: ProyectoDoc;
}

/**
 * La marca de "me cerraron bien", en localStorage y no en IndexedDB.
 *
 * Tiene que ser localStorage justamente porque es sincronico: la marca se pone
 * en el `pagehide`, y ahi la pagina ya se esta muriendo. Una escritura a
 * IndexedDB abre una transaccion y no llega a terminar nunca, asi que un cierre
 * normal se leia despues como si se hubiera caido la app.
 */
const CLAVE_CIERRE = 'predit:cierre-limpio';

export function marcarCierreLimpio(): void {
  try {
    localStorage.setItem(CLAVE_CIERRE, '1');
  } catch {
    // Sin localStorage se pierde la distincion y todo cierre parece un corte.
    // Es el lado seguro del error: ofrecer retomar de mas, nunca de menos.
  }
}

/**
 * Si la vez anterior la app se cerro bien. Vale para toda esta carga de la
 * pagina y despues se olvida.
 *
 * La respuesta queda cacheada en el modulo, y no solo en localStorage, porque
 * el efecto que la consulta corre dos veces en desarrollo (StrictMode monta,
 * desmonta y vuelve a montar): si la marca se levantara en la primera pasada,
 * la segunda leeria "no cerro bien" y todo cierre normal se veria como un
 * corte.
 */
let cierreLimpio: boolean | null = null;

export function tomarCierreLimpio(): boolean {
  if (cierreLimpio === null) {
    cierreLimpio = leerMarca();
    olvidarCierreLimpio();
  }
  return cierreLimpio;
}

function leerMarca(): boolean {
  try {
    return localStorage.getItem(CLAVE_CIERRE) !== null;
  } catch {
    return false;
  }
}

/**
 * Borra la marca sin consumir la respuesta del arranque. Es para la pagina que
 * se fue al bfcache y volvio: no se cerro, asi que si mas tarde se cae tiene
 * que contar como corte.
 */
export function olvidarCierreLimpio(): void {
  try {
    localStorage.removeItem(CLAVE_CIERRE);
  } catch {
    // Sin localStorage no hay marca que borrar.
  }
}

let db: Promise<IDBDatabase | null> | null = null;

function abrir(): Promise<IDBDatabase | null> {
  if (db) return db;
  db = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let solicitud: IDBOpenDBRequest;
    try {
      solicitud = indexedDB.open(DB_NOMBRE, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    solicitud.onupgradeneeded = () => {
      const base = solicitud.result;
      if (!base.objectStoreNames.contains(PROYECTOS)) base.createObjectStore(PROYECTOS, { keyPath: 'id' });
      if (!base.objectStoreNames.contains(LUTS)) base.createObjectStore(LUTS, { keyPath: 'id' });
      if (!base.objectStoreNames.contains(SESION)) base.createObjectStore(SESION);
      if (!base.objectStoreNames.contains(MEDIOS)) base.createObjectStore(MEDIOS, { keyPath: 'id' });
    };
    solicitud.onsuccess = () => resolve(solicitud.result);
    solicitud.onerror = () => resolve(null);
    solicitud.onblocked = () => resolve(null);
  });
  return db;
}

function pedir<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB rechazo el pedido'));
  });
}

/**
 * Corre algo contra un store y devuelve null si no se pudo.
 *
 * En una escritura espera el `complete` de la transaccion y no el `success` del
 * pedido: en Safari el pedido puede decir que si y la transaccion abortar
 * despues por cuota, y ahi el dato no quedo guardado.
 */
async function conStore<T>(
  nombre: string,
  modo: IDBTransactionMode,
  trabajo: (store: IDBObjectStore) => Promise<T>,
): Promise<T | null> {
  const base = await abrir();
  if (!base) return null;
  try {
    const tx = base.transaction(nombre, modo);
    const fin =
      modo === 'readwrite'
        ? new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('La transaccion fallo'));
            tx.onabort = () => reject(tx.error ?? new Error('La transaccion se aborto'));
          })
        : Promise.resolve();
    const resultado = await trabajo(tx.objectStore(nombre));
    await fin;
    return resultado;
  } catch {
    return null;
  }
}

export async function guardarProyecto(doc: ProyectoDoc): Promise<boolean> {
  const hecho = await conStore(PROYECTOS, 'readwrite', (store) => pedir(store.put(doc)));
  return hecho !== null;
}

export async function leerProyecto(id: string): Promise<ProyectoDoc | null> {
  const doc = await conStore(PROYECTOS, 'readonly', (store) =>
    pedir<ProyectoDoc | undefined>(store.get(id)),
  );
  return doc ?? null;
}

/** Los proyectos guardados, del mas reciente al mas viejo. */
export async function listarProyectos(): Promise<ResumenProyecto[]> {
  const docs = await conStore(PROYECTOS, 'readonly', (store) =>
    pedir<ProyectoDoc[]>(store.getAll()),
  );
  if (!docs) return [];
  return docs.map(resumir).sort((a, b) => b.actualizado - a.actualizado);
}

/** Los documentos enteros, para saber que medios sigue usando alguien. */
async function todosLosDocs(): Promise<ProyectoDoc[]> {
  const docs = await conStore(PROYECTOS, 'readonly', (store) =>
    pedir<ProyectoDoc[]>(store.getAll()),
  );
  return docs ?? [];
}

export async function borrarProyecto(id: string): Promise<void> {
  await conStore(PROYECTOS, 'readwrite', (store) => pedir(store.delete(id)));
}

export async function guardarSesion(doc: ProyectoDoc): Promise<void> {
  const sesion: SesionGuardada = { doc };
  await conStore(SESION, 'readwrite', (store) => pedir(store.put(sesion, CLAVE_SESION)));
}

export async function leerSesion(): Promise<SesionGuardada | null> {
  const sesion = await conStore(SESION, 'readonly', (store) =>
    pedir<SesionGuardada | undefined>(store.get(CLAVE_SESION)),
  );
  return sesion ?? null;
}

export async function borrarSesion(): Promise<void> {
  await conStore(SESION, 'readwrite', (store) => pedir(store.delete(CLAVE_SESION)));
}

/**
 * La biblioteca de LUTs es global, no de un proyecto: el `.cube` de la FX6 es
 * el mismo en todos los montajes y subirlo una vez tiene que alcanzar.
 */
export async function guardarLut(lut: LutGuardado): Promise<void> {
  await conStore(LUTS, 'readwrite', (store) => pedir(store.put(lut)));
}

export async function leerLuts(): Promise<LutGuardado[]> {
  const luts = await conStore(LUTS, 'readonly', (store) => pedir<LutGuardado[]>(store.getAll()));
  return luts ?? [];
}

export async function borrarLut(id: string): Promise<void> {
  await conStore(LUTS, 'readwrite', (store) => pedir(store.delete(id)));
}

/**
 * Una copia de un archivo importado, con los bytes adentro de la app.
 *
 * Los blobs viven aparte de los proyectos, en su propio store y con la clave de
 * la huella: dos proyectos que usan el mismo clip -o un clip partido en dos-
 * comparten una unica copia, y borrar un proyecto no se lleva puesto el
 * material del otro.
 */
export interface MedioGuardado {
  /** `claveMedio(huella)`: nombre|tamano|fecha. */
  id: string;
  nombre: string;
  tamano: number;
  /** El `lastModified` original, para poder rearmar el File igual que era. */
  fecha: number;
  /** El MIME del File, que `probeClip` y el `<video>` esperan encontrar. */
  tipo: string;
  blob: Blob;
  guardado: number;
}

/** Lo mismo pero sin los bytes, para la pantalla de almacenamiento. */
export type MedioResumen = Omit<MedioGuardado, 'blob'>;

/**
 * Guarda una copia del archivo para no tener que volver a pedirlo nunca mas.
 *
 * Devuelve false si no se pudo -tipicamente la cuota-, y el proyecto sigue
 * andando igual: lo unico que se pierde es la comodidad, porque al reabrir se
 * va a pedir ese archivo a mano.
 *
 * Si ya hay una copia con la misma clave no se reescribe: son los mismos bytes
 * y copiar 120 MB al pedo en un telefono se siente.
 */
export async function guardarMedio(file: File): Promise<boolean> {
  const id = claveMedio(huellaDe(file));
  const yaEsta = await conStore(MEDIOS, 'readonly', (store) =>
    pedir<number>(store.count(id)),
  );
  if (yaEsta) return true;

  const medio: MedioGuardado = {
    id,
    nombre: file.name,
    tamano: file.size,
    fecha: file.lastModified,
    tipo: file.type,
    blob: file,
    guardado: Date.now(),
  };
  const hecho = await conStore(MEDIOS, 'readwrite', (store) => pedir(store.put(medio)));
  return hecho !== null;
}

/**
 * Rearma los archivos guardados, en una sola transaccion.
 *
 * Vuelve un File y no un Blob porque abajo todo lo espera asi: `probeClip`
 * mira el nombre, `huellaDe` necesita nombre y fecha, y el autoguardado que
 * corre despues de restaurar tiene que volver a escribir la misma huella. Con
 * el nombre y el lastModified originales, el clip restaurado es indistinguible
 * del recien importado.
 */
export async function leerMedios(ids: string[]): Promise<Map<string, File>> {
  const encontrados = new Map<string, File>();
  if (ids.length === 0) return encontrados;
  const unicos = [...new Set(ids)];
  const medios = await conStore(MEDIOS, 'readonly', async (store) => {
    const leidos = await Promise.all(
      unicos.map((id) => pedir<MedioGuardado | undefined>(store.get(id))),
    );
    return leidos;
  });
  if (!medios) return encontrados;
  for (const medio of medios) {
    if (!medio) continue;
    encontrados.set(
      medio.id,
      new File([medio.blob], medio.nombre, { type: medio.tipo, lastModified: medio.fecha }),
    );
  }
  return encontrados;
}

/** Todas las copias guardadas, sin los bytes. */
export async function listarMedios(): Promise<MedioResumen[]> {
  const medios = await conStore(MEDIOS, 'readonly', (store) =>
    pedir<MedioGuardado[]>(store.getAll()),
  );
  if (!medios) return [];
  return medios.map(({ blob: _blob, ...resto }) => resto);
}

export async function borrarMedios(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await conStore(MEDIOS, 'readwrite', async (store) => {
    await Promise.all([...new Set(ids)].map((id) => pedir(store.delete(id))));
  });
}

/** Cuanto ocupan las copias, en bytes. */
export async function pesoMedios(): Promise<number> {
  const medios = await listarMedios();
  return medios.reduce((acc, m) => acc + m.tamano, 0);
}

/**
 * Las claves que hoy usa alguien: cualquier proyecto de la lista, o la sesion.
 *
 * La sesion entra porque el montaje abierto puede no tener nombre todavia y no
 * figurar en ningun proyecto guardado: sin esto, limpiar huerfanos le sacaria
 * el material de abajo de los pies.
 */
async function clavesEnUso(): Promise<Set<string>> {
  const [docs, sesion] = await Promise.all([todosLosDocs(), leerSesion()]);
  const usadas = new Set<string>();
  for (const doc of docs) for (const clave of mediosDe(doc)) usadas.add(clave);
  if (sesion) for (const clave of mediosDe(sesion.doc)) usadas.add(clave);
  return usadas;
}

/**
 * Borra las copias que ya no reclama ningun proyecto y devuelve cuanto libero.
 *
 * Es la limpieza segura: no toca nada que se pueda volver a abrir. Lo tipico
 * que junta son los clips de un proyecto borrado y los que se importaron,
 * se probaron y se sacaron del montaje.
 */
export async function purgarHuerfanos(): Promise<number> {
  const [usadas, medios] = await Promise.all([clavesEnUso(), listarMedios()]);
  const sobran = medios.filter((m) => !usadas.has(m.id));
  await borrarMedios(sobran.map((m) => m.id));
  return sobran.reduce((acc, m) => acc + m.tamano, 0);
}

/**
 * Libera las copias de un montaje puntual: lo que se ofrece al terminar de
 * exportar, cuando el material ya cumplio y son varios gigas.
 *
 * Solo borra lo que ningun OTRO proyecto este usando, asi que liberar el
 * montaje de hoy no rompe el de la semana pasada que compartia dos clips.
 */
export async function liberarMediosDe(doc: ProyectoDoc): Promise<number> {
  const propias = new Set(mediosDe(doc));
  if (propias.size === 0) return 0;

  const docs = await todosLosDocs();
  const ajenas = new Set<string>();
  for (const otro of docs) {
    if (otro.id === doc.id) continue;
    for (const clave of mediosDe(otro)) ajenas.add(clave);
  }

  const medios = await listarMedios();
  const victimas = medios.filter((m) => propias.has(m.id) && !ajenas.has(m.id));
  await borrarMedios(victimas.map((m) => m.id));
  return victimas.reduce((acc, m) => acc + m.tamano, 0);
}

/**
 * Le pide al navegador que no borre estos datos por su cuenta.
 *
 * Sin esto Safari limpia el almacenamiento del sitio a los siete dias de no
 * usarlo, que es exactamente el caso "vuelvo del viaje y abro los proyectos".
 * En una PWA instalada suele conceder el permiso sin preguntar nada.
 */
export async function pedirPersistencia(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
