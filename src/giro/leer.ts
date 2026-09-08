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
import type { DatosGiro, MuestraGiro, Optica, SinGiro, TiemposCuadro } from './tipos';

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

/**
 * @param anchoDelVideo el ancho en pixeles de la imagen, que hace falta para
 * pasar la focal de pixeles del sensor a pixeles de la salida. Sin el, la
 * optica vuelve en null y el usuario la ajusta a mano.
 */
export async function leerGiroscopio(
  file: File,
  anchoDelVideo = 0,
): Promise<DatosGiro | SinGiro> {
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
    let muestras: MuestraGiro[];
    let optica: Optica | null = null;
    let claves: string[] = [];
    let orientacionEjes: string | null = null;
    let modelo: string | null = null;
    // Sony dice cuando se expuso el cuadro respecto de su timestamp; GoPro no.
    let tiempos: TiemposCuadro | null = null;
    if (fuente === 'sony') {
      const leido = leerSony(crudas, anchoDelVideo);
      muestras = leido.muestras;
      optica = leido.optica;
      orientacionEjes = leido.orientacionEjes;
      tiempos = leido.tiempos;
    } else {
      // GoPro guarda su propia calibracion de fabrica en el archivo, asi que de
      // aca sale tanto la focal como el modelo del ojo de pez.
      const leido = leerGoPro(crudas, anchoDelVideo);
      muestras = leido.muestras;
      optica = leido.optica;
      claves = leido.claves;
      orientacionEjes = leido.orientacionEjes;
      modelo = leido.modelo;
    }

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
      optica,
      claves,
      orientacionEjes,
      modelo,
      tiempos,
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
