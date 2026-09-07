/**
 * La puerta de entrada: de un archivo de video a las curvas del giroscopio.
 *
 * Elige el parser mirando el formato de la pista de metadata y no el modelo de
 * camara: 'gpmd' es GoPro y 'rtmd' es Sony, y eso vale para toda la familia sin
 * tener que mantener una lista de modelos.
 *
 * Nunca tira: un clip sin giroscopio -un iPhone, algo que ya paso por un
 * editor- es lo normal, no un error, y lo que devuelve dice por que.
 */

import { leerGoPro } from './gopro';
import { leerMuestras, pistasDeMetadata, type PistaMeta } from './mp4';
import { leerSony } from './sony';
import type { DatosGiro, MuestraGiro, SinGiro } from './tipos';

/** Los formatos de pista que sabemos leer. */
const FORMATOS = { gpmd: 'gopro', rtmd: 'sony' } as const;

/**
 * Cuantas muestras de la pista se leen como maximo.
 *
 * Una pista de metadata tiene una muestra por cuadro, asi que diez mil son unos
 * siete minutos a 24p: de sobra para un clip de montaje, y un techo para que un
 * archivo raro no coma toda la memoria del telefono.
 */
const TOPE_MUESTRAS = 10000;

/**
 * La frecuencia real de las mediciones, contada y no declarada.
 *
 * Se mide sobre lo que efectivamente se leyo porque es el numero que dice si el
 * parseo salio bien: un giroscopio da entre 200 y 2000 Hz, asi que un resultado
 * de 30 Hz significa que se leyo una medicion por cuadro y se perdio el resto.
 */
function frecuenciaReal(muestras: MuestraGiro[]): number {
  if (muestras.length < 2) return 0;
  const span = muestras[muestras.length - 1]!.segundo - muestras[0]!.segundo;
  return span > 0 ? (muestras.length - 1) / span : 0;
}

export async function leerGiroscopio(file: File): Promise<DatosGiro | SinGiro> {
  let pistas: PistaMeta[];
  try {
    pistas = await pistasDeMetadata(file);
  } catch (e) {
    return { motivo: `No se pudo leer el contenedor: ${comoTexto(e)}`, pistas: [] };
  }

  const nombres = pistas.map((p) => `${p.formato} (${p.muestras.length} muestras)`);
  if (pistas.length === 0) {
    return {
      motivo: 'El archivo no tiene ninguna pista de metadata: no hay giroscopio para leer.',
      pistas: nombres,
    };
  }

  const pista = pistas.find((p) => p.formato in FORMATOS);
  if (!pista) {
    return {
      motivo: 'Hay pistas de metadata, pero ninguna en un formato de giroscopio conocido.',
      pistas: nombres,
    };
  }

  const fuente = FORMATOS[pista.formato as keyof typeof FORMATOS];
  const recortadas = pista.muestras.slice(0, TOPE_MUESTRAS);

  try {
    const bytes = await leerMuestras(file, recortadas);
    const crudas = bytes.map((b, i) => ({ bytes: b, segundo: recortadas[i]!.segundo }));
    const muestras = fuente === 'sony' ? leerSony(crudas) : leerGoPro(crudas);

    if (muestras.length === 0) {
      return {
        motivo: `La pista ${pista.formato} está pero no trae mediciones de giroscopio (puede ser un modelo que solo escribe GPS o exposición).`,
        pistas: nombres,
      };
    }

    return {
      fuente,
      formato: pista.formato,
      muestras,
      hz: frecuenciaReal(muestras),
      duracionSeconds: muestras[muestras.length - 1]!.segundo - muestras[0]!.segundo,
    };
  } catch (e) {
    return { motivo: `No se pudo interpretar la pista: ${comoTexto(e)}`, pistas: nombres };
  }
}

/** Si lo que volvio son datos o una explicacion de por que no los hay. */
export function hayGiro(r: DatosGiro | SinGiro): r is DatosGiro {
  return 'muestras' in r;
}

function comoTexto(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
