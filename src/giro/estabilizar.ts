/**
 * De las mediciones del giroscopio a la correccion que va al shader.
 *
 * El camino es siempre el mismo, y son cuatro pasos:
 *
 *  1. INTEGRAR. El giroscopio no dice hacia donde apunta la camara, dice a que
 *     velocidad esta girando. Sumando esas velocidades cuadro a cuadro se
 *     reconstruye la orientacion real en cada momento.
 *  2. SUAVIZAR. Esa orientacion real incluye el temblor de la mano. Pasandola
 *     por un filtro se obtiene una camara "virtual" que hace el mismo
 *     movimiento pero sin los saltos.
 *  3. CORREGIR. La diferencia entre las dos es cuanto hay que rotar la imagen
 *     para que se vea como si la camara hubiera hecho el movimiento suave.
 *  4. RECORTAR. Rotar la imagen descubre los bordes, asi que hay que agrandarla
 *     lo justo para que no entre negro en ningun cuadro.
 *
 * Lo que NO hace, por decision explicita: no corrige la distorsion del lente
 * (no hay perfil de lente) ni el obturador rodante. Las dos cosas mejoran el
 * resultado, pero las dos necesitan datos que hoy no tenemos, y sin ellas la
 * estabilizacion ya funciona.
 */

import {
  aMatriz,
  desdeVelocidad,
  IDENTIDAD,
  inverso,
  multiplicar,
  normalizar,
  slerp,
  type Quat,
} from './quat';
import type { FuenteGiro, MuestraGiro } from './tipos';

/** La orientacion de la camara en un momento del clip. */
export interface Orientacion {
  segundo: number;
  q: Quat;
}

/**
 * Como se mapean los ejes del giroscopio a los de la imagen.
 *
 * Es lo unico que no se puede deducir de los datos: cada fabricante monta el
 * chip como quiere, y si los ejes estan cruzados la correccion va para el lado
 * equivocado y la imagen tiembla el doble en vez de la mitad. Se deja
 * configurable justamente porque la unica forma de confirmarlo es probar con un
 * clip de verdad.
 *
 * Cada entrada dice de que eje del giroscopio sale, y con que signo.
 */
export interface Mapeo {
  pitch: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
  yaw: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
  roll: { de: 'x' | 'y' | 'z'; signo: 1 | -1 };
}

/**
 * Traduce la cadena de ejes que declara la camara a un mapeo, leyendola
 * EXACTAMENTE como Gyroflow.
 *
 * No hay documentacion de Sony ni de GoPro que diga en que marco de referencia
 * estan los ejes: la unica referencia que funciona con clips reales es la
 * cadena de Gyroflow (telemetry-parser + gyroflow-core), asi que se copia su
 * lectura paso a paso, y cada paso esta citado:
 *
 *  1. `orient()` (telemetry-parser, tags_impl.rs): la letra de la posicion i
 *     dice de que canal sale la componente i; la minuscula la niega.
 *  2. Sony: `normalize_imu_orientation()` (telemetry-parser, sony/mod.rs)
 *     intercambia las posiciones 0 y 1 e invierte el signo de la tercera ANTES
 *     de todo lo demas. GoPro no normaliza nada.
 *  3. `SimpleGyroIntegrator` (gyroflow, imu_integration/mod.rs) integra
 *     `omega = (-g[1], g[0], g[2])`: la componente 1 es el pitch (negado), la 0
 *     es el yaw y la 2 es el roll. Ese marco tiene la y hacia ARRIBA y la z
 *     hacia ATRAS (OpenGL).
 *  4. `frame_transform.rs` conjuga la rotacion con diag(1, -1, -1) para pasar
 *     al marco de la camara con la y hacia abajo y la z hacia adelante, que es
 *     el que usa nuestra matriz K. Sobre la velocidad angular eso niega la y y
 *     la z.
 *
 * Juntando 3 y 4, en nuestro marco: pitch = -g[1], yaw = -g[0], roll = -g[2].
 *
 * La lectura anterior de este archivo -posicion 0 = pitch, 1 = yaw- tenia el
 * pitch y el yaw cruzados respecto de Gyroflow, y por eso ninguna combinacion
 * de letras terminaba de estabilizar.
 */
export function mapeoDesdeOrientacion(declarada: string, fuente: FuenteGiro = 'gopro'): Mapeo | null {
  let letras = declarada.trim();
  if (letras.length !== 3) return null;
  if (fuente === 'sony') letras = normalizarSony(letras);

  const canal = (letra: string | undefined) => {
    if (!letra) return null;
    const eje = letra.toLowerCase();
    if (eje !== 'x' && eje !== 'y' && eje !== 'z') return null;
    // La minuscula es el eje negativo; la mayuscula, el positivo.
    return { de: eje as 'x' | 'y' | 'z', signo: (letra === eje ? -1 : 1) as 1 | -1 };
  };

  const g0 = canal(letras[0]);
  const g1 = canal(letras[1]);
  const g2 = canal(letras[2]);
  if (!g0 || !g1 || !g2) return null;
  // Los tres tienen que salir de canales distintos: si uno se repite, otro
  // quedo sin usar y el mapeo no describe una rotacion.
  if (new Set([g0.de, g1.de, g2.de]).size !== 3) return null;

  const negado = (g: { de: 'x' | 'y' | 'z'; signo: 1 | -1 }) =>
    ({ de: g.de, signo: (-g.signo) as 1 | -1 });
  return { pitch: negado(g1), yaw: negado(g0), roll: negado(g2) };
}

/**
 * Lo que telemetry-parser le hace a la cadena de Sony antes de usarla:
 * intercambia las dos primeras letras e invierte el signo de la tercera.
 */
function normalizarSony(letras: string): string {
  const tercera = letras[2]!;
  const invertida = tercera === tercera.toLowerCase() ? tercera.toUpperCase() : tercera.toLowerCase();
  return letras[1]! + letras[0]! + invertida;
}

/**
 * El mapeo cuando la camara no declara nada: la cadena "XYZ", que es lo que
 * asume Gyroflow (gyro_source/mod.rs) cuando telemetry-parser no devuelve
 * orientacion. Es el caso de las GoPro HERO 8 en adelante, que escriben ORIN
 * pero no ORIO, y sin las dos telemetry-parser no arma la cadena.
 */
export const MAPEO_GOPRO: Mapeo = mapeoDesdeOrientacion('XYZ', 'gopro')!;

/** Lo mismo para Sony, que ademas pasa por su normalizacion. */
export const MAPEO_SONY: Mapeo = mapeoDesdeOrientacion('XYZ', 'sony')!;

const GRADOS_A_RADIANES = Math.PI / 180;

/**
 * Reconstruye la orientacion de la camara sumando las velocidades.
 *
 * El paso de tiempo sale de la diferencia entre mediciones y no de la
 * frecuencia declarada: si la pista tiene un hueco -y las tienen- usar el paso
 * nominal correria todo lo que viene despues.
 */
export function integrar(muestras: MuestraGiro[], mapeo: Mapeo): Orientacion[] {
  const salida: Orientacion[] = [];
  if (muestras.length === 0) return salida;

  const eje = (m: MuestraGiro, cual: Mapeo['pitch']) => m[cual.de] * cual.signo * GRADOS_A_RADIANES;

  let q: Quat = IDENTIDAD;
  salida.push({ segundo: muestras[0]!.segundo, q });

  for (let i = 1; i < muestras.length; i++) {
    const m = muestras[i]!;
    const dt = m.segundo - muestras[i - 1]!.segundo;
    // Un salto grande es un corte en la pista, no un giro de dos segundos:
    // integrarlo inventaria una rotacion enorme.
    if (dt > 0 && dt < 0.5) {
      q = normalizar(multiplicar(q, desdeVelocidad([eje(m, mapeo.pitch), eje(m, mapeo.yaw), eje(m, mapeo.roll)], dt)));
    }
    salida.push({ segundo: m.segundo, q });
  }
  return salida;
}

/**
 * El filtro que saca el temblor y deja el movimiento.
 *
 * Es un pasabajos exponencial aplicado en las dos direcciones: primero hacia
 * adelante y despues hacia atras. Pasarlo dos veces no es por prolijidad, es
 * necesario: un filtro en una sola direccion siempre atrasa la senal, y una
 * correccion atrasada es peor que ninguna porque mueve la imagen justo despues
 * del golpe. Yendo y volviendo, los dos atrasos se cancelan.
 *
 * `suavidad` es cuantos segundos de movimiento se promedian: mas alto es una
 * camara mas quieta, pero tambien mas recorte y mas sensacion de flotar.
 */
export function suavizar(
  orientaciones: Orientacion[],
  suavidad: number,
  /**
   * Suavizado adaptativo a la velocidad, en grados por segundo. 0 lo apaga.
   *
   * Un filtro con un solo tiempo de suavizado tiene un dilema: si es largo,
   * se atrasa en los paneos y pide un recorte enorme; si es corto, deja pasar
   * el balanceo de caminar. Gyroflow lo resuelve bajando el suavizado cuando
   * la camara gira rapido (un paneo hay que seguirlo) y subiendolo cuando
   * gira despacio (ahi es temblor). Esto es esa idea: el tiempo de suavizado
   * efectivo es suavidad / (1 + (w / referencia)^2), con w la velocidad
   * angular medida y ya suavizada un poquito.
   */
  velocidadDeReferencia = 0,
): Orientacion[] {
  if (orientaciones.length === 0) return [];
  if (suavidad <= 0) return orientaciones.map((o) => ({ ...o }));

  const factor = factoresDeVelocidad(orientaciones, velocidadDeReferencia);

  const paso = (lista: Orientacion[], atras: boolean): Orientacion[] => {
    const salida = lista.map((o) => ({ segundo: o.segundo, q: o.q }));
    const indices = atras
      ? [...salida.keys()].reverse()
      : [...salida.keys()];

    let acumulado = salida[indices[0]!]!.q;
    for (const i of indices) {
      const actual = salida[i]!;
      const previo = atras ? salida[i + 1] : salida[i - 1];
      const dt = previo ? Math.abs(actual.segundo - previo.segundo) : 0;
      // Cuanto pesa la medicion nueva: con dt chico frente a la suavidad, casi
      // nada, y la orientacion filtrada se mueve despacio.
      const alfa = dt > 0 ? 1 - Math.exp(-dt / (suavidad * factor[i]!)) : 1;
      acumulado = normalizar(slerp(acumulado, actual.q, alfa));
      salida[i] = { segundo: actual.segundo, q: acumulado };
    }
    return salida;
  };

  return paso(paso(orientaciones, false), true);
}

/**
 * Cuanto se acorta el tiempo de suavizado en cada instante, de 0 a 1.
 *
 * La velocidad angular se mide entre orientaciones vecinas y se le pasa un
 * pasabajos corto (ida y vuelta, 0.15 s) para que el temblor rapido no la
 * infle: lo que importa es si la camara esta paneando, no si vibra.
 */
function factoresDeVelocidad(orientaciones: Orientacion[], referencia: number): number[] {
  const n = orientaciones.length;
  if (referencia <= 0) return new Array<number>(n).fill(1);

  const velocidad = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = orientaciones[i - 1]!;
    const b = orientaciones[i]!;
    const dt = b.segundo - a.segundo;
    if (dt <= 0) continue;
    const rel = multiplicar(inverso(a.q), b.q);
    velocidad[i] = ((2 * Math.acos(Math.min(1, Math.abs(rel[0]))) * 180) / Math.PI) / dt;
  }
  velocidad[0] = velocidad[1] ?? 0;

  const pasada = (lista: number[], atras: boolean) => {
    const salida = lista.slice();
    const indices = atras ? [...salida.keys()].reverse() : [...salida.keys()];
    let acumulado = salida[indices[0]!]!;
    for (const i of indices) {
      const previo = atras ? orientaciones[i + 1] : orientaciones[i - 1];
      const dt = previo ? Math.abs(orientaciones[i]!.segundo - previo.segundo) : 0;
      const alfa = dt > 0 ? 1 - Math.exp(-dt / 0.15) : 1;
      acumulado += (salida[i]! - acumulado) * alfa;
      salida[i] = acumulado;
    }
    return salida;
  };
  const lenta = pasada(pasada(velocidad, false), true);
  return lenta.map((w) => 1 / (1 + (w / referencia) * (w / referencia)));
}

/** Busca la orientacion en un momento cualquiera, interpolando entre mediciones. */
export function orientacionEn(lista: Orientacion[], segundo: number): Quat {
  if (lista.length === 0) return IDENTIDAD;
  if (segundo <= lista[0]!.segundo) return lista[0]!.q;
  const ultimo = lista[lista.length - 1]!;
  if (segundo >= ultimo.segundo) return ultimo.q;

  // Busqueda binaria: la lista puede tener decenas de miles de entradas y esto
  // se llama una vez por cuadro.
  let bajo = 0;
  let alto = lista.length - 1;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (lista[medio]!.segundo <= segundo) bajo = medio;
    else alto = medio;
  }
  const a = lista[bajo]!;
  const b = lista[alto]!;
  const span = b.segundo - a.segundo;
  return span > 0 ? slerp(a.q, b.q, (segundo - a.segundo) / span) : a.q;
}

export interface Opciones {
  /** Cuantos segundos de movimiento se promedian. */
  suavidad: number;
  /**
   * Cuanto se corre el giroscopio respecto del video, en segundos.
   *
   * Positivo significa que el giroscopio va adelantado y hay que atrasarlo. En
   * Sony y GoPro los relojes son buenos y esto queda casi siempre en cero; esta
   * para poder ajustarlo a ojo cuando no.
   */
  desfase: number;
  /**
   * La distancia focal en pixeles de la imagen de salida.
   *
   * Es lo que traduce "la camara giro un grado" a "la imagen se corre tantos
   * pixeles". Sin perfil de lente se saca de la metadata de la camara, y si no
   * esta, el usuario la ajusta a ojo.
   */
  focalPx: number;
  ancho: number;
  alto: number;
  mapeo: Mapeo;
  /** Ver suavizar(). 0 o ausente = suavizado fijo. */
  velocidadDeReferencia?: number;
  /**
   * Cuanto se acepta agrandar la imagen, como maximo. 1.3 es 30% de recorte.
   *
   * El zoom que se usa es el que le alcanza al 95% de los cuadros, topeado por
   * este numero. Lo que no entra -un golpe, un tropezon- se corrige de menos
   * solo en ese momento (ver curvaDeGanancia), y el resto del clip conserva su
   * encuadre y su correccion completa.
   */
  zoomMaximo: number;
}

/** La estabilizacion ya resuelta, lista para que la consulte el renderer. */
export interface Estabilizacion {
  /**
   * La matriz 3x3 que lleva un pixel de la imagen de SALIDA al pixel de la
   * imagen de ENTRADA que hay que muestrear, en orden por filas.
   */
  matrizEn: (segundo: number) => number[];
  /**
   * Lo mismo pero en coordenadas de textura (0 a 1), que es lo que consume el
   * shader.
   *
   * El shader trabaja en UV y no en pixeles porque asi no necesita saber a que
   * resolucion se decodifico el cuadro: la misma matriz sirve para el preview
   * chico y para el export a tamano completo.
   */
  matrizUvEn: (segundo: number) => number[];
  /** Cuanto se agranda la imagen, ya con el tope aplicado. */
  zoom: number;
  /**
   * Cuanto haria falta agrandar para corregir TODO sin bordes negros.
   *
   * Si es mayor que `zoom`, no alcanza el recorte y se esta corrigiendo de
   * menos. Se muestra para que la decision sea del usuario y no una sorpresa.
   */
  zoomIdeal: number;
  /**
   * Que fraccion de la correccion se aplica, de 0 a 1, PROMEDIADA en el clip.
   *
   * La ganancia varia en el tiempo (ver curvaDeGanancia): en el cuerpo del clip
   * es 1 y alrededor de un golpe baja. Este numero resume; `gananciaEn` da la
   * de un instante.
   */
  ganancia: number;
  /** La ganancia mas baja del clip: hasta donde llega a bajar en el peor golpe. */
  gananciaMinima: number;
  /** Que fraccion del clip se corrige (casi) entera: ganancia mayor a 0.95. */
  fraccionCompleta: number;
  /** La ganancia en un instante dado. */
  gananciaEn: (segundo: number) => number;
  /**
   * La correccion que se esta aplicando en un instante, en grados por eje,
   * ya con la ganancia. Es diagnostico: si estos numeros se mueven con el
   * temblor y la imagen no, el problema esta entre la matriz y el shader.
   */
  correccionEn: (segundo: number) => { pitch: number; yaw: number; roll: number };
  /** El angulo maximo que llega a corregir, en grados. Es el diagnostico. */
  correccionMaxGrados: number;
}

/**
 * Arma la matriz de muestreo para una correccion dada.
 *
 * Es K · R · K⁻¹ con K la matriz de la camara: se lleva el pixel de salida al
 * rayo que le corresponde, se lo rota hacia donde apuntaba la camara de verdad,
 * y se lo vuelve a proyectar a pixel. El zoom entra achicando la focal del lado
 * de la salida, que es lo mismo que acercar la camara virtual.
 */
function matrizDeMuestreo(q: Quat, o: Opciones, zoom: number): number[] {
  const r = aMatriz(q);
  const cx = o.ancho / 2;
  const cy = o.alto / 2;
  const fEntrada = o.focalPx;
  const fSalida = o.focalPx * zoom;

  // K⁻¹ del lado de la salida, R, y K del lado de la entrada, multiplicadas a
  // mano: son matrices con muchos ceros y armar el producto general seria mas
  // codigo y mas lento.
  const m: number[] = [];
  for (let fila = 0; fila < 3; fila++) {
    for (let col = 0; col < 3; col++) {
      // Columna de K⁻¹ (salida): [1/f, 0, -cx/f; 0, 1/f, -cy/f; 0, 0, 1]
      const kx = col === 0 ? 1 / fSalida : col === 2 ? -cx / fSalida : 0;
      const ky = col === 1 ? 1 / fSalida : col === 2 ? -cy / fSalida : 0;
      const kz = col === 2 ? 1 : 0;
      // R por esa columna.
      const rx = r[0]! * kx + r[1]! * ky + r[2]! * kz;
      const ry = r[3]! * kx + r[4]! * ky + r[5]! * kz;
      const rz = r[6]! * kx + r[7]! * ky + r[8]! * kz;
      // K (entrada) por el resultado.
      m.push(fila === 0 ? fEntrada * rx + cx * rz : fila === 1 ? fEntrada * ry + cy * rz : rz);
    }
  }
  return m;
}

/** Aplica la matriz a un punto y hace la division de perspectiva. */
function aplicar(m: number[], x: number, y: number): [number, number] {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  const k = Math.abs(w) < 1e-9 ? 1e9 : 1 / w;
  return [(m[0]! * x + m[1]! * y + m[2]!) * k, (m[3]! * x + m[4]! * y + m[5]!) * k];
}

/**
 * Cuanto se exige de sobra al recortar la ganancia, como fraccion del lado
 * menor. La ganancia se calcula en instantes discretos y se interpola entre
 * ellos; en un golpe rapido la correccion cambia tanto entre dos instantes que
 * sin este margen asoma un pixel de borde.
 */
const MARGEN_DE_GANANCIA = 0.002;

/**
 * El zoom mas chico que evita los bordes negros en TODO el clip.
 *
 * Se prueba por biseccion: con un zoom candidato se transforman las cuatro
 * esquinas de cada cuadro y se mira si alguna cae fuera de la imagen original.
 * Es fuerza bruta, pero corre una sola vez al preparar el clip y son unas pocas
 * decenas de miles de multiplicaciones.
 *
 * Se mira una muestra de cuadros y no todos: el zoom lo decide el peor momento
 * del clip, y ese momento dura mucho mas que un cuadro.
 */
function esquinasDentro(q: Quat, o: Opciones, zoom: number, margen = 0): boolean {
  const m = matrizDeMuestreo(q, o, zoom);
  for (const [ex, ey] of [
    [0, 0],
    [o.ancho, 0],
    [0, o.alto],
    [o.ancho, o.alto],
  ] as const) {
    const [px, py] = aplicar(m, ex, ey);
    if (px < margen || py < margen || px > o.ancho - margen || py > o.alto - margen) return false;
  }
  return true;
}


/**
 * La ganancia mas alta, de 0 a 1, con la que UNA correccion entra en el
 * recorte disponible. 1 si entra entera.
 */
function gananciaQueEntra(correccion: Quat, o: Opciones, zoom: number): number {
  // Si entra entera sin margen, es 1 y punto: asi el zoom "ideal" da ganancia
  // exactamente 1. El margen se exige solo cuando hay que recortar la ganancia.
  if (esquinasDentro(correccion, o, zoom)) return 1;
  const margen = MARGEN_DE_GANANCIA * Math.min(o.ancho, o.alto);
  const entra = (g: number) => esquinasDentro(slerp(IDENTIDAD, correccion, g), o, zoom, margen);
  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 16; i++) {
    const medio = (bajo + alto) / 2;
    if (entra(medio)) bajo = medio;
    else alto = medio;
  }
  return bajo;
}

/** El zoom mas chico que evita los bordes negros para UNA correccion. */
function zoomNecesario(correccion: Quat, o: Opciones): number {
  const alcanza = (zoom: number): boolean => esquinasDentro(correccion, o, zoom);
  if (alcanza(1)) return 1;
  let bajo = 1;
  let alto = 4;
  if (!alcanza(alto)) return alto;
  for (let i = 0; i < 20; i++) {
    const medio = (bajo + alto) / 2;
    if (alcanza(medio)) alto = medio;
    else bajo = medio;
  }
  return alto;
}

/**
 * Cada cuanto se muestrea el clip para decidir zoom y ganancia.
 *
 * Tiene que ser mas fino que un golpe: un golpe dura un cuarto de segundo, y
 * si se lo saltea el cuadro que cae adentro muestra borde negro.
 */
const PASO_DE_MUESTREO = 0.04;
/** Un techo para que un clip de una hora no cueste minutos de calculo. */
const MAXIMO_DE_MUESTRAS = 6000;

/**
 * Cuanto dura la "bajada" de la ganancia alrededor de un golpe.
 *
 * Es el attack y el release de un limitador de audio: la ganancia empieza a
 * bajar medio segundo antes del golpe y termina de volver medio segundo
 * despues. Mas corto se ve como un tiron; mas largo le roba correccion a lo
 * que rodea al golpe.
 */
const VENTANA_DE_GANANCIA = 0.5;
const SUAVIDAD_DE_GANANCIA = 0.25;

/**
 * Que fraccion del clip decide el zoom.
 *
 * El zoom es el mismo para todo el clip (si cambiara, la imagen respiraria),
 * asi que alguien tiene que decidirlo. El peor cuadro no puede ser: un golpe de
 * dos segundos le cobraria 30% de encuadre a los dos minutos restantes. Se toma
 * el zoom que le alcanza al 90% de los cuadros, y el 10% restante se corrige de
 * menos con la ganancia local. Es 90 y no 95 porque el suavizado "desparrama"
 * un golpe: la orientacion suave se separa de la real desde un segundo antes,
 * y un golpe de dos segundos ocupa cuatro o cinco.
 */
const PERCENTIL_DEL_ZOOM = 0.9;

/**
 * La ganancia a lo largo del clip: cuanto de la correccion se aplica en cada
 * momento, de 0 a 1.
 *
 * Aca se juntan las dos lecciones anteriores, y hay que respetar las dos:
 *
 * - Acotar cada cuadro por separado (bug 4) satura: todos los cuadros pegan
 *   contra el mismo tope y la correccion deja de ser proporcional al temblor.
 * - Escalar TODO por un numero (bug 7) deja que un golpe de dos segundos apague
 *   la correccion de los otros ciento cincuenta. En un clip real la ganancia
 *   global daba 30%, y un temblor de 2 grados corregido al 30% no se ve.
 *
 * La salida: una ganancia que varia EN EL TIEMPO pero despacio. Se calcula la
 * ganancia maxima por cuadro, se pasa por un filtro de minimo (la ventana) y
 * despues por el mismo suavizado ida y vuelta que la orientacion. En el cuerpo
 * del clip da 1; alrededor de un golpe baja suavemente y vuelve. Es un
 * limitador con attack y release, no un fader.
 *
 * El clamp final al maximo por cuadro es para no mostrar borde negro nunca:
 * el suavizado puede quedar un poco por arriba del maximo justo en el golpe.
 */
function curvaDeGanancia(tiempos: number[], maximos: number[]): number[] {
  const n = tiempos.length;
  if (n === 0) return [];

  // Filtro de minimo en la ventana.
  const envolvente = new Array<number>(n);
  let desde = 0;
  for (let i = 0; i < n; i++) {
    while (tiempos[i]! - tiempos[desde]! > VENTANA_DE_GANANCIA) desde++;
    let minimo = 1;
    for (let j = desde; j < n && tiempos[j]! - tiempos[i]! <= VENTANA_DE_GANANCIA; j++) {
      minimo = Math.min(minimo, maximos[j]!);
    }
    envolvente[i] = minimo;
  }

  // Pasabajos exponencial ida y vuelta, igual que suavizar().
  const paso = (lista: number[], atras: boolean) => {
    const salida = lista.slice();
    const indices = atras ? [...salida.keys()].reverse() : [...salida.keys()];
    let acumulado = salida[indices[0]!]!;
    for (const i of indices) {
      const previo = atras ? tiempos[i + 1] : tiempos[i - 1];
      const dt = previo === undefined ? 0 : Math.abs(tiempos[i]! - previo);
      const alfa = dt > 0 ? 1 - Math.exp(-dt / SUAVIDAD_DE_GANANCIA) : 1;
      acumulado += (salida[i]! - acumulado) * alfa;
      salida[i] = acumulado;
    }
    return salida;
  };
  const suave = paso(paso(envolvente, false), true);

  return suave.map((g, i) => Math.min(g, maximos[i]!));
}

/** Interpola una curva muestreada en el tiempo. Se planta en los extremos. */
function valorEn(tiempos: number[], valores: number[], segundo: number): number {
  const n = tiempos.length;
  if (n === 0) return 1;
  if (segundo <= tiempos[0]!) return valores[0]!;
  if (segundo >= tiempos[n - 1]!) return valores[n - 1]!;
  let bajo = 0;
  let alto = n - 1;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (tiempos[medio]! <= segundo) bajo = medio;
    else alto = medio;
  }
  const span = tiempos[alto]! - tiempos[bajo]!;
  const t = span > 0 ? (segundo - tiempos[bajo]!) / span : 0;
  return valores[bajo]! + (valores[alto]! - valores[bajo]!) * t;
}

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 1;
  const ordenados = valores.slice().sort((a, b) => a - b);
  const indice = Math.min(ordenados.length - 1, Math.floor(p * (ordenados.length - 1)));
  return ordenados[indice]!;
}

/** Producto de dos matrices 3x3 en orden por filas. */
function producto(a: number[], b: number[]): number[] {
  const m: number[] = [];
  for (let fila = 0; fila < 3; fila++) {
    for (let col = 0; col < 3; col++) {
      m.push(
        a[fila * 3]! * b[col]! + a[fila * 3 + 1]! * b[3 + col]! + a[fila * 3 + 2]! * b[6 + col]!,
      );
    }
  }
  return m;
}

/**
 * Pasa una matriz de pixeles a coordenadas de textura.
 *
 * Son dos cambios, y el segundo es el que costo encontrar:
 *
 * 1. La escala: se entra un UV, se lo lleva a pixeles para aplicar la matriz,
 *    y el resultado se vuelve a normalizar. Es diag(1/w, 1/h, 1) * m * diag(w, h, 1).
 *
 * 2. El espejo vertical. En los pixeles la y crece hacia ABAJO, pero el
 *    renderer sube el video con UNPACK_FLIP_Y_WEBGL, asi que en la textura
 *    v = 0 es el borde de abajo y v = 1 el de arriba. Hay que conjugar la
 *    matriz con ese espejo (v' = 1 - v) a los dos lados.
 *
 * Sin el espejo la matriz "funciona" -las esquinas entran, los tests de
 * coherencia pasan- pero un espejo aplicado a una rotacion invierte el
 * sentido del pitch y del roll y deja el yaw como estaba. En pantalla: los
 * paneos horizontales se corrigen y los movimientos verticales y la
 * inclinacion se DUPLICAN. Gyroflow tiene un `framebuffer_inverted` para
 * exactamente esto.
 */
function aEspacioUv(m: number[], o: Opciones): number[] {
  const w = o.ancho;
  const h = o.alto;
  const escalada = [
    m[0]!, (m[1]! * h) / w, m[2]! / w,
    (m[3]! * w) / h, m[4]!, m[5]! / h,
    m[6]! * w, m[7]! * h, m[8]!,
  ];
  // El espejo es su propia inversa, asi que va igual a los dos lados.
  const espejo = [1, 0, 0, 0, -1, 1, 0, 0, 1];
  return producto(espejo, producto(escalada, espejo));
}

/**
 * Prepara la estabilizacion de un clip.
 *
 * `cuadros` son los momentos en los que se va a pedir la correccion, y sirven
 * para calcular el zoom: hay que conocer el peor cuadro del clip ANTES de
 * dibujar el primero, porque el zoom tiene que ser el mismo en todos (si
 * cambiara cuadro a cuadro, la imagen respiraria).
 */
export function prepararEstabilizacion(
  muestras: MuestraGiro[],
  cuadros: number[],
  o: Opciones,
): Estabilizacion {
  const reales = integrar(muestras, o.mapeo);
  const suaves = suavizar(reales, o.suavidad, o.velocidadDeReferencia ?? 0);

  const correccionEn = (segundo: number): Quat => {
    const t = segundo + o.desfase;
    /*
     * La rotacion con la que hay que MUESTREAR, que no es la misma que la
     * correccion "conceptual" y el orden importa.
     *
     * La camara real ve un rayo del mundo d como inv(R_real)*d. Un pixel de la
     * salida vive en la camara virtual, asi que su rayo es v = inv(R_suave)*d;
     * despejando d y metiendolo en la primera, el rayo que le corresponde en la
     * imagen real es inv(R_real)*R_suave*v.
     *
     * Invertir este producto -o darlo vuelta- no corrige menos: corrige para el
     * otro lado, y la imagen tiembla el doble en vez de la mitad.
     */
    return normalizar(multiplicar(inverso(orientacionEn(reales, t)), orientacionEn(suaves, t)));
  };

  /*
   * Se muestrea el clip parejo y fino, sin importar cuantos `cuadros` hayan
   * pedido: el zoom y la ganancia tienen que ver el golpe de un cuarto de
   * segundo, y doscientos puntos en dos minutos no lo ven.
   */
  const desde = cuadros.length > 0 ? Math.min(...cuadros) : 0;
  const hasta = cuadros.length > 0 ? Math.max(...cuadros) : 0;
  const cantidad = Math.max(
    cuadros.length,
    Math.min(MAXIMO_DE_MUESTRAS, Math.floor((hasta - desde) / PASO_DE_MUESTREO) + 1),
  );
  const tiempos =
    cantidad <= 1
      ? cuadros.slice()
      : Array.from({ length: cantidad }, (_, i) => desde + ((hasta - desde) * i) / (cantidad - 1));
  const correcciones = tiempos.map(correccionEn);

  const zoomPorCuadro = correcciones.map((q) => zoomNecesario(q, o));
  const zoomIdeal = zoomPorCuadro.reduce((a, b) => Math.max(a, b), 1);
  const tope = Math.max(1, o.zoomMaximo);
  // Si todo el clip entra en el tope, se corrige todo y listo. Si no, el zoom
  // lo decide el grueso del clip (el percentil) y no el golpe.
  const zoom = zoomIdeal <= tope ? zoomIdeal : Math.min(percentil(zoomPorCuadro, PERCENTIL_DEL_ZOOM), tope);

  const maximos = correcciones.map((q) => gananciaQueEntra(q, o, zoom));
  const ganancias = curvaDeGanancia(tiempos, maximos);
  const gananciaEn = (segundo: number) => valorEn(tiempos, ganancias, segundo);

  let maximo = 0;
  for (const q of correcciones) {
    maximo = Math.max(maximo, 2 * Math.acos(Math.min(1, Math.abs(q[0]))));
  }

  const aplicadaEn = (segundo: number): Quat =>
    slerp(IDENTIDAD, correccionEn(segundo), gananciaEn(segundo));
  const matriz = (segundo: number) => matrizDeMuestreo(aplicadaEn(segundo), o, zoom);

  const promedio = ganancias.length > 0 ? ganancias.reduce((a, b) => a + b, 0) / ganancias.length : 1;
  const aGrados = 180 / Math.PI;

  return {
    matrizEn: matriz,
    matrizUvEn: (segundo) => aEspacioUv(matriz(segundo), o),
    zoom,
    zoomIdeal,
    ganancia: promedio,
    gananciaMinima: ganancias.reduce((a, b) => Math.min(a, b), 1),
    fraccionCompleta:
      ganancias.length > 0 ? ganancias.filter((g) => g > 0.95).length / ganancias.length : 1,
    gananciaEn,
    correccionEn: (segundo) => {
      // Para angulos chicos, cada componente vectorial del cuaternion es la
      // mitad del giro alrededor de ese eje.
      const q = aplicadaEn(segundo);
      const signo = q[0] < 0 ? -1 : 1;
      return {
        pitch: 2 * Math.asin(Math.max(-1, Math.min(1, q[1] * signo))) * aGrados,
        yaw: 2 * Math.asin(Math.max(-1, Math.min(1, q[2] * signo))) * aGrados,
        roll: 2 * Math.asin(Math.max(-1, Math.min(1, q[3] * signo))) * aGrados,
      };
    },
    correccionMaxGrados: maximo * aGrados,
  };
}

/**
 * Una "estabilizacion" que gira la imagen un angulo fijo. Es diagnostico.
 *
 * Sirve para separar dos problemas que en pantalla se ven iguales: que la
 * correccion este mal calculada, o que no llegue al visor. Si al mover esto la
 * imagen no se corre, el problema esta entre la matriz y el shader y ninguna
 * combinacion de ejes lo va a arreglar.
 */
export function estabilizacionFija(
  grados: { pitch: number; yaw: number; roll: number },
  o: Pick<Opciones, 'focalPx' | 'ancho' | 'alto'>,
): Estabilizacion {
  const completa: Opciones = {
    ...o,
    suavidad: 0,
    desfase: 0,
    mapeo: MAPEO_GOPRO,
    zoomMaximo: 1,
  };
  const q = normalizar(
    desdeVelocidad(
      [grados.pitch * GRADOS_A_RADIANES, grados.yaw * GRADOS_A_RADIANES, grados.roll * GRADOS_A_RADIANES],
      1,
    ),
  );
  const matriz = () => matrizDeMuestreo(q, completa, 1);
  return {
    matrizEn: matriz,
    matrizUvEn: () => aEspacioUv(matriz(), completa),
    zoom: 1,
    zoomIdeal: 1,
    ganancia: 1,
    gananciaMinima: 1,
    fraccionCompleta: 1,
    gananciaEn: () => 1,
    correccionEn: () => grados,
    correccionMaxGrados: Math.hypot(grados.pitch, grados.yaw, grados.roll),
  };
}
