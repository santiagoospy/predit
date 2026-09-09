/**
 * Los LUTs que vienen con la app, iguales para todo el mundo.
 *
 * Viven en `public/luts/` y no en IndexedDB: son parte del programa, no material
 * del usuario. Vite los copia tal cual a `dist/` y el service worker los mete en
 * el precache (ver `globPatterns` en vite.config.ts), asi que despues de la
 * primera visita estan disponibles en modo avion como el resto de la app.
 *
 * Los ids son fijos y estan escritos a mano, nunca generados con `nextId`. Un
 * clip guarda solo el id del LUT que usa, y al restaurar un proyecto
 * `reconstruir` descarta en silencio los ids que no encuentra en la biblioteca:
 * si estos cambiaran entre versiones, todos los montajes guardados perderian su
 * correccion de color sin avisar. El prefijo `fabrica:` ademas los mantiene
 * lejos de los ids del usuario, que son `lutN-xxxxxx`.
 */

import { parseCube } from './cube';
import type { LibraryLut } from '../edit/types';

interface LutFabrica {
  /** Fijo para siempre: lo tienen guardado los proyectos. */
  id: string;
  /** Lo que se lee en el boton. */
  name: string;
  /** El archivo dentro de `public/luts/`. */
  archivo: string;
}

export const LUTS_FABRICA: readonly LutFabrica[] = [
  { id: 'fabrica:dji-dlog-rec709', name: 'DJI D-Log → 709', archivo: 'dji-dlog-rec709.cube' },
  { id: 'fabrica:gopro-rec709', name: 'GoPro → 709', archivo: 'gopro-rec709.cube' },
  { id: 'fabrica:gopro-slog3', name: 'GoPro → S-Log3', archivo: 'gopro-slog3.cube' },
  { id: 'fabrica:slog3-santios', name: 'slog3 santios', archivo: 'slog3-santios.cube' },
  { id: 'fabrica:teal', name: 'Teal', archivo: 'teal.cube' },
];

/** Si el id es de un LUT que trae la app y no de uno que subio el usuario. */
export function esDeFabrica(id: string): boolean {
  return id.startsWith('fabrica:');
}

async function traer(entrada: LutFabrica): Promise<LibraryLut | null> {
  try {
    // BASE_URL y no "/" a secas: si algun dia la app se sirve desde un
    // subdirectorio, la ruta absoluta apuntaria fuera.
    const respuesta = await fetch(`${import.meta.env.BASE_URL}luts/${entrada.archivo}`);
    if (!respuesta.ok) return null;
    return { id: entrada.id, name: entrada.name, lut: parseCube(await respuesta.text()) };
  } catch {
    return null;
  }
}

/**
 * Trae los LUTs de fabrica, los que se pueda.
 *
 * Cada uno falla por su cuenta y se lo saltea: quedarse sin los LUTs de fabrica
 * -primera visita sin red, un archivo que no subio al deploy- empobrece la app
 * pero no puede impedir editar. El unico costo real de que falten es que un
 * proyecto guardado que usaba uno pierda esa correccion al restaurar, que es
 * exactamente lo que ya pasa hoy con un LUT del usuario que no esta.
 */
export async function cargarLutsFabrica(): Promise<LibraryLut[]> {
  const traidos = await Promise.all(LUTS_FABRICA.map(traer));
  return traidos.filter((l): l is LibraryLut => l !== null);
}
