/**
 * El pedacito de MP4 que hace falta para llegar al giroscopio.
 *
 * mediabunny solo entrega pistas de video, audio y subtitulos, y el giroscopio
 * no vive en ninguna de las tres: las camaras lo escriben en una pista aparte,
 * de tipo "metadata", que ninguna API del navegador expone. Asi que hay que
 * abrir el contenedor a mano.
 *
 * Esto NO es un demuxer: no decodifica nada ni entiende de video. Solo camina
 * el arbol de cajas hasta la tabla de muestras de las pistas de metadata y
 * devuelve donde empieza cada muestra, cuanto mide y en que segundo del clip
 * cae. Que hay ADENTRO de esos bytes es problema de sony.ts y gopro.ts.
 *
 * Todo se lee por rebanadas del File, nunca el archivo entero: un clip de la
 * FX30 pesa varios gigas y la pista de metadata son unos pocos megas.
 */

/** Una muestra de la pista: un bloque de bytes con su momento en el clip. */
export interface MuestraMeta {
  /** Posicion absoluta en el archivo. */
  offset: number;
  tamano: number;
  /** Cuando empieza, en segundos desde el arranque del clip. */
  segundo: number;
}

/** Una pista de metadata encontrada en el archivo. */
export interface PistaMeta {
  /** El hdlr, que para estas pistas es siempre 'meta'. */
  handler: string;
  /**
   * El formato de la stsd, que es lo que dice de que camara es: 'gpmd' es
   * GoPro, 'rtmd' es Sony. Es la unica pista de la deteccion.
   */
  formato: string;
  timescale: number;
  muestras: MuestraMeta[];
}

/** Una caja del contenedor: cuatro letras, y donde viven sus datos. */
interface Caja {
  tipo: string;
  inicio: number;
  fin: number;
}

/**
 * Cuanto se acepta leer de una sola vez al buscar las cabeceras.
 *
 * El moov de un clip largo puede pesar varios megas (son las tablas de todas
 * las muestras del video), pero es una fraccion diminuta del archivo. El tope
 * esta para no comerse la memoria del telefono si el archivo esta corrupto y
 * dice cualquier cosa.
 */
const TOPE_MOOV = 64 * 1024 * 1024;

function texto(vista: DataView, pos: number): string {
  return String.fromCharCode(
    vista.getUint8(pos),
    vista.getUint8(pos + 1),
    vista.getUint8(pos + 2),
    vista.getUint8(pos + 3),
  );
}

/**
 * Lista las cajas que hay entre dos posiciones.
 *
 * Una caja es tamano (4 bytes) + tipo (4 letras) + contenido. El tamano 1
 * significa "no entraba en 32 bits, el de verdad son los 8 bytes siguientes",
 * y el 0 significa "hasta el final". Los dos casos aparecen en archivos de
 * camara de verdad, asi que los dos estan contemplados.
 */
function cajas(vista: DataView, desde: number, hasta: number): Caja[] {
  const encontradas: Caja[] = [];
  let pos = desde;
  while (pos + 8 <= hasta) {
    let tamano = vista.getUint32(pos);
    const tipo = texto(vista, pos + 4);
    let cabecera = 8;
    if (tamano === 1) {
      if (pos + 16 > hasta) break;
      // Los tamanos de 64 bits se leen en dos mitades: getBigUint64 devuelve
      // BigInt y no vale la pena arrastrarlo por un numero que siempre entra
      // holgado en un double.
      tamano = vista.getUint32(pos + 8) * 2 ** 32 + vista.getUint32(pos + 12);
      cabecera = 16;
    } else if (tamano === 0) {
      tamano = hasta - pos;
    }
    if (tamano < cabecera) break;
    const fin = Math.min(pos + tamano, hasta);
    encontradas.push({ tipo, inicio: pos + cabecera, fin });
    pos += tamano;
  }
  return encontradas;
}

/** Camina un camino de cajas anidadas, por ejemplo minf y despues stbl. */
function bajar(vista: DataView, caja: Caja, camino: string[]): Caja | null {
  let actual: Caja | null = caja;
  for (const paso of camino) {
    if (!actual) return null;
    actual = cajas(vista, actual.inicio, actual.fin).find((c) => c.tipo === paso) ?? null;
  }
  return actual;
}

/**
 * Encuentra el moov sin leer el archivo entero.
 *
 * Vale la pena el paseo por las cajas de primer nivel porque el moov puede
 * estar al principio (lo normal en camaras) o al final (lo normal en algo que
 * paso por un editor), y en el segundo caso lo que hay en el medio son todos
 * los gigas del video.
 */
async function ubicarMoov(file: File): Promise<{ inicio: number; fin: number } | null> {
  let pos = 0;
  while (pos + 16 <= file.size) {
    const cabecera = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let tamano = cabecera.getUint32(0);
    const tipo = texto(cabecera, 4);
    let salto = 8;
    if (tamano === 1) {
      tamano = cabecera.getUint32(8) * 2 ** 32 + cabecera.getUint32(12);
      salto = 16;
    } else if (tamano === 0) {
      tamano = file.size - pos;
    }
    if (tamano < salto) return null;
    if (tipo === 'moov') return { inicio: pos + salto, fin: Math.min(pos + tamano, file.size) };
    pos += tamano;
  }
  return null;
}

/** El hdlr dice de que es la pista: 'vide', 'soun' o 'meta'. */
function leerHandler(vista: DataView, mdia: Caja): string | null {
  const hdlr = cajas(vista, mdia.inicio, mdia.fin).find((c) => c.tipo === 'hdlr');
  // 4 de version+flags, 4 de pre_defined, y recien ahi el tipo.
  if (!hdlr || hdlr.inicio + 12 > hdlr.fin) return null;
  return texto(vista, hdlr.inicio + 8);
}

/** El mdhd trae el timescale, que es con lo que los tiempos se vuelven segundos. */
function leerTimescale(vista: DataView, mdia: Caja): number {
  const mdhd = cajas(vista, mdia.inicio, mdia.fin).find((c) => c.tipo === 'mdhd');
  if (!mdhd) return 0;
  const version = vista.getUint8(mdhd.inicio);
  // En la version 1 las fechas son de 64 bits y corren todo 12 bytes.
  const pos = mdhd.inicio + (version === 1 ? 20 : 12);
  return pos + 4 <= mdhd.fin ? vista.getUint32(pos) : 0;
}

/** El formato de la stsd: cuatro letras que dicen que camara escribio esto. */
function leerFormato(vista: DataView, stbl: Caja): string {
  const stsd = cajas(vista, stbl.inicio, stbl.fin).find((c) => c.tipo === 'stsd');
  if (!stsd || stsd.inicio + 16 > stsd.fin) return '';
  // 4 de version+flags, 4 de cantidad de entradas, y la primera entrada es una
  // caja normal: tamano + tipo.
  return texto(vista, stsd.inicio + 12);
}

/**
 * Los tiempos de cada muestra, desplegando la stts.
 *
 * La tabla viene comprimida como "N muestras que duran D cada una", que en una
 * pista de metadata suele ser una sola fila para todo el clip.
 */
function leerTiempos(vista: DataView, stbl: Caja, cuantas: number): number[] {
  const stts = cajas(vista, stbl.inicio, stbl.fin).find((c) => c.tipo === 'stts');
  const tiempos: number[] = [];
  if (!stts) return tiempos;
  const filas = vista.getUint32(stts.inicio + 4);
  let acumulado = 0;
  for (let i = 0; i < filas; i++) {
    const pos = stts.inicio + 8 + i * 8;
    if (pos + 8 > stts.fin) break;
    const cantidad = vista.getUint32(pos);
    const duracion = vista.getUint32(pos + 4);
    for (let j = 0; j < cantidad && tiempos.length < cuantas; j++) {
      tiempos.push(acumulado);
      acumulado += duracion;
    }
  }
  return tiempos;
}

/** Los tamanos de cada muestra: o uno fijo para todas, o la lista entera. */
function leerTamanos(vista: DataView, stbl: Caja): number[] {
  const stsz = cajas(vista, stbl.inicio, stbl.fin).find((c) => c.tipo === 'stsz');
  if (!stsz) return [];
  const fijo = vista.getUint32(stsz.inicio + 4);
  const cantidad = vista.getUint32(stsz.inicio + 8);
  if (fijo !== 0) return new Array<number>(cantidad).fill(fijo);
  const tamanos: number[] = [];
  for (let i = 0; i < cantidad; i++) {
    const pos = stsz.inicio + 12 + i * 4;
    if (pos + 4 > stsz.fin) break;
    tamanos.push(vista.getUint32(pos));
  }
  return tamanos;
}

/** Donde arranca cada trozo: stco si son 32 bits, co64 si son 64. */
function leerTrozos(vista: DataView, stbl: Caja): number[] {
  const hijas = cajas(vista, stbl.inicio, stbl.fin);
  const stco = hijas.find((c) => c.tipo === 'stco');
  const co64 = hijas.find((c) => c.tipo === 'co64');
  const trozos: number[] = [];
  if (stco) {
    const cantidad = vista.getUint32(stco.inicio + 4);
    for (let i = 0; i < cantidad; i++) {
      const pos = stco.inicio + 8 + i * 4;
      if (pos + 4 > stco.fin) break;
      trozos.push(vista.getUint32(pos));
    }
  } else if (co64) {
    const cantidad = vista.getUint32(co64.inicio + 4);
    for (let i = 0; i < cantidad; i++) {
      const pos = co64.inicio + 8 + i * 8;
      if (pos + 8 > co64.fin) break;
      trozos.push(vista.getUint32(pos) * 2 ** 32 + vista.getUint32(pos + 4));
    }
  }
  return trozos;
}

/**
 * Cuantas muestras entran en cada trozo, desplegando la stsc.
 *
 * La tabla dice "a partir del trozo N, cada trozo trae M muestras", asi que hay
 * que rellenar los trozos intermedios hasta la fila siguiente.
 */
function leerPorTrozo(vista: DataView, stbl: Caja, cuantosTrozos: number): number[] {
  const stsc = cajas(vista, stbl.inicio, stbl.fin).find((c) => c.tipo === 'stsc');
  const porTrozo = new Array<number>(cuantosTrozos).fill(0);
  if (!stsc) return porTrozo;
  const filas = vista.getUint32(stsc.inicio + 4);
  const entradas: { primero: number; cuantas: number }[] = [];
  for (let i = 0; i < filas; i++) {
    const pos = stsc.inicio + 8 + i * 12;
    if (pos + 12 > stsc.fin) break;
    entradas.push({ primero: vista.getUint32(pos), cuantas: vista.getUint32(pos + 4) });
  }
  for (let i = 0; i < entradas.length; i++) {
    const desde = entradas[i]!.primero - 1;
    const hasta = i + 1 < entradas.length ? entradas[i + 1]!.primero - 1 : cuantosTrozos;
    for (let t = desde; t < hasta && t < cuantosTrozos; t++) porTrozo[t] = entradas[i]!.cuantas;
  }
  return porTrozo;
}

/**
 * Las pistas de metadata del archivo, con la ubicacion de cada muestra.
 *
 * Devuelve la lista vacia si el archivo no tiene ninguna, que es un caso
 * comun y no un error: un clip de iPhone, o uno que ya paso por un editor, no
 * traen giroscopio.
 */
export async function pistasDeMetadata(file: File): Promise<PistaMeta[]> {
  const donde = await ubicarMoov(file);
  if (!donde) return [];
  if (donde.fin - donde.inicio > TOPE_MOOV) return [];

  const buffer = await file.slice(donde.inicio, donde.fin).arrayBuffer();
  const vista = new DataView(buffer);
  const raiz: Caja = { tipo: 'moov', inicio: 0, fin: buffer.byteLength };

  const pistas: PistaMeta[] = [];
  for (const trak of cajas(vista, raiz.inicio, raiz.fin).filter((c) => c.tipo === 'trak')) {
    const mdia = bajar(vista, trak, ['mdia']);
    if (!mdia) continue;
    const handler = leerHandler(vista, mdia);
    if (handler !== 'meta') continue;
    const stbl = bajar(vista, mdia, ['minf', 'stbl']);
    if (!stbl) continue;

    const timescale = leerTimescale(vista, mdia) || 1;
    const tamanos = leerTamanos(vista, stbl);
    const trozos = leerTrozos(vista, stbl);
    const porTrozo = leerPorTrozo(vista, stbl, trozos.length);
    const tiempos = leerTiempos(vista, stbl, tamanos.length);

    // Las muestras se cuentan corriendo por los trozos: dentro de cada uno van
    // pegadas una atras de la otra, y la tabla solo guarda donde empieza el
    // trozo. Las posiciones son absolutas dentro del archivo, no relativas al
    // moov, asi que sirven tal cual para rebanar el File.
    const muestras: MuestraMeta[] = [];
    let indice = 0;
    for (let t = 0; t < trozos.length; t++) {
      let offset = trozos[t]!;
      for (let j = 0; j < porTrozo[t]! && indice < tamanos.length; j++) {
        const tamano = tamanos[indice]!;
        muestras.push({ offset, tamano, segundo: (tiempos[indice] ?? 0) / timescale });
        offset += tamano;
        indice++;
      }
    }

    pistas.push({ handler, formato: leerFormato(vista, stbl), timescale, muestras });
  }
  return pistas;
}

/**
 * Trae los bytes de varias muestras de una sola lectura.
 *
 * Las muestras de una pista de metadata estan pegadas en el archivo, asi que
 * pedir el rango entero y despues cortarlo en memoria es una sola ida al disco
 * en vez de miles. Si vinieran salteadas igual funciona, solo que lee de mas.
 */
export async function leerMuestras(file: File, muestras: MuestraMeta[]): Promise<ArrayBuffer[]> {
  if (muestras.length === 0) return [];
  const desde = Math.min(...muestras.map((m) => m.offset));
  const hasta = Math.max(...muestras.map((m) => m.offset + m.tamano));
  const bloque = await file.slice(desde, hasta).arrayBuffer();
  return muestras.map((m) => bloque.slice(m.offset - desde, m.offset - desde + m.tamano));
}
