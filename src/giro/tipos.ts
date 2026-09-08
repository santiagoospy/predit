/**
 * Lo que sale de leer el giroscopio, en unidades utiles y ya independiente de
 * que camara lo escribio.
 */

/** Una medicion del giroscopio: cuando, y cuanto giro en cada eje. */
export interface MuestraGiro {
  /** Segundos desde el arranque del clip. */
  segundo: number;
  /** Velocidad angular en grados por segundo. */
  x: number;
  y: number;
  z: number;
}

/** De donde salio el giroscopio. Determina como se leen los bytes. */
export type FuenteGiro = 'sony' | 'gopro';

/**
 * El modelo radial de un lente ojo de pez, tal como lo calibra GoPro.
 *
 * Un lente normal se comporta como un agujero de alfiler: un punto a X grados
 * del centro cae a `focal * tan(X)` pixeles del centro, y las lineas rectas del
 * mundo salen rectas. Un ojo de pez no: para meter 150 grados en el cuadro
 * comprime cada vez mas hacia los bordes, y por eso el horizonte se curva.
 *
 * GoPro guarda la relacion exacta en el archivo, como un polinomio que va del
 * radio (normalizado a la media diagonal) al angulo en radianes. Eso es una
 * calibracion de fabrica de ESA camara: mejor que cualquier perfil generico, y
 * la razon por la que no hace falta una base de datos de lentes.
 */
export interface ModeloRadial {
  /** r0..r6, tal cual vienen: angulo = r0 + r1*p + r2*p^2 + ... */
  poly: number[];
  /** El multiplicador que se le aplica al radio normalizado antes del polinomio. */
  zmpl: number;
  /**
   * El angulo del rayo mas abierto que entro en el cuadro, en radianes.
   *
   * Es la mitad del campo diagonal. Sirve de tope: mas alla de eso no hay
   * imagen, y el polinomio devolveria valores sin sentido.
   */
  anguloMaxRad: number | null;
  /** Como llama GoPro al modo: Wide, Linear, Superview, Hyperview... */
  modo: string;
}

/**
 * La optica con la que se filmo, leida de la metadata de la camara.
 *
 * Es lo que traduce "la camara giro un grado" a "la imagen se corre tantos
 * pixeles". La formula es simple: los grados que abarca la imagen dependen de
 * cuantos milimetros de sensor se estan leyendo y de la focal del lente.
 *
 * Las dos mitades vienen de lados distintos, y esto importa: el ancho del
 * sensor lo escribe la CAMARA (tamano del pixel por recorte del sensor), asi
 * que aparece siempre. La focal la escribe el LENTE, asi que con un lente
 * manual -sin contactos electricos- no aparece y la tiene que poner el usuario.
 */
export interface Optica {
  /**
   * Distancia focal en pixeles de la imagen de salida, o null si el lente no
   * declaro sus milimetros.
   */
  focalPx: number | null;
  /** Los milimetros que declaro el lente, o null si es manual. */
  focalMm: number | null;
  /**
   * Cuantos milimetros de ancho de sensor esta leyendo la camara.
   *
   * Es mejor que preguntar "aps-c o full frame": este numero ya tiene adentro
   * el modo de recorte (un cuerpo full frame filmando en Super35 lee 23 mm, no
   * 36) y el recorte del formato, que un menu de sensores no distinguiria.
   */
  sensorAnchoMm: number | null;
  /** El ancho de la imagen en pixeles, para recalcular con otra focal. */
  anchoPx: number;
  /**
   * Como deforma el lente, si la camara lo calibro.
   *
   * Sin esto la estabilizacion trata la imagen como si fuera de un lente
   * normal, y en un ojo de pez eso corrige mal: el mismo giro mueve los bordes
   * mucho menos que el centro. Ademas es lo que permite enderezar el horizonte.
   */
  radial: ModeloRadial | null;
}

/**
 * La focal en pixeles a partir de los milimetros del lente.
 *
 * Es una regla de tres: la focal es a los milimetros de sensor lo que la focal
 * en pixeles es al ancho de la imagen.
 */
export function focalPxDesdeMm(mm: number, sensorAnchoMm: number, anchoPx: number): number | null {
  if (!(mm > 0) || !(sensorAnchoMm > 0) || !(anchoPx > 0)) return null;
  return (mm / sensorAnchoMm) * anchoPx;
}

/**
 * Cuando se expuso cada cuadro respecto de su timestamp, si la camara lo dice.
 *
 * El timestamp de un cuadro es un numero del contenedor; la imagen se expuso
 * en algun momento cerca de el, y "cerca" son decenas de milisegundos: en una
 * Sony a 25p el centro del cuadro se expone unos 43 ms DESPUES del timestamp.
 * Un temblor de caminar tiene 5 a 10 Hz, asi que 43 ms es media fase: sin
 * este dato la correccion llega tarde y suma temblor en vez de sacarlo.
 *
 * Y dentro del cuadro las filas no se exponen todas a la vez: el sensor se lee
 * de arriba a abajo en `tiempoDeLectura` segundos (obturador rodante), asi
 * que la fila de arriba es medio tiempo de lectura anterior al centro y la de
 * abajo medio posterior.
 */
export interface TiemposCuadro {
  /** Cuanto despues del timestamp del cuadro se expuso su fila del medio, en segundos. */
  retardoDelCuadro: number;
  /** Cuanto tarda el sensor en leerse de arriba a abajo, en segundos. 0 = obturador global. */
  tiempoDeLectura: number;
}

/** El giroscopio de un clip, listo para dibujar o para estabilizar. */
export interface DatosGiro {
  fuente: FuenteGiro;
  /** Las cuatro letras de la pista, para el diagnostico. */
  formato: string;
  muestras: MuestraGiro[];
  /** Cuantas mediciones por segundo tiene de verdad, medido y no declarado. */
  hz: number;
  /** Cuanto abarca, en segundos. */
  duracionSeconds: number;
  /** La optica, si la camara la escribio. */
  optica: Optica | null;
  /**
   * Las claves crudas que trajo el archivo, para poder ver que hay adentro.
   *
   * Solo sirve cuando algo no aparece: distingue "lo lei mal" de "la camara no
   * lo escribio", que sin esto son el mismo sintoma.
   */
  claves: string[];
  /**
   * Como declara la camara el orden y el signo de los ejes, si lo declara.
   *
   * GoPro lo escribe en ORIN y Sony en su tag 0xe43a. Es el dato que convierte
   * el mapeo de ejes de una suposicion en algo leido del archivo.
   */
  orientacionEjes: string | null;
  /** El modelo, tal como lo escribe la camara. */
  modelo: string | null;
  /** Cuando se expuso el cuadro respecto de su timestamp. Sony lo escribe; GoPro no. */
  tiempos: TiemposCuadro | null;
}

/** Por que no se pudo leer el giroscopio. Se muestra tal cual al usuario. */
export interface SinGiro {
  motivo: string;
  /** Las pistas de metadata que si aparecieron, para saber que se encontro. */
  pistas: string[];
}
