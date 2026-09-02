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
import { resumir, type ProyectoDoc, type ResumenProyecto } from './esquema';

const DB_NOMBRE = 'predit';
const DB_VERSION = 1;

const PROYECTOS = 'proyectos';
const LUTS = 'luts';
const SESION = 'sesion';

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
