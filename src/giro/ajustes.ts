/**
 * Los ajustes de estabilizacion de un clip: lo que el usuario mueve a mano.
 *
 * Estan separados de `tipos.ts` a proposito. Aquello es lo que sale del ARCHIVO
 * -las mediciones del giroscopio, la optica que declaro la camara- y se vuelve
 * a leer igual siempre; esto es lo que decidio la PERSONA, que no esta en
 * ningun lado mas y es lo unico que hay que guardar en el proyecto.
 *
 * Por eso viven en el clip (`TimelineClip.giro`) y no en el panel: asi se
 * serializan solos con el resto del montaje y sobreviven a cerrar la app. Las
 * mediciones, en cambio, no se guardan: son megabytes y se releen del archivo.
 */

/** Todo lo que el usuario mueve para UN clip. */
export interface AjustesGiro {
  activo: boolean;
  /** Cuantos segundos de movimiento se promedian para sacar el temblor. */
  suavidad: number;
  /** Cuanto se corre el giroscopio respecto del video, en milisegundos. */
  desfaseMs: number;
  /**
   * Los milimetros que puso el usuario a mano.
   *
   * Hace falta con un lente manual: sin contactos electricos, la camara no sabe
   * que lente tiene puesto y no escribe la focal. El ancho del sensor si lo
   * escribe, asi que con el numero del barril del lente alcanza.
   */
  mmAMano: string;
  /**
   * El campo de vision a ojo, para cuando no hay NI focal NI sensor.
   *
   * Es el caso de las GoPro que no escriben su calibracion. Sin este numero no
   * se puede saber cuantos pixeles mover por cada grado que giro la camara, y
   * es preferible una perilla honesta que un valor inventado.
   */
  fovAMano: number;
  /**
   * Cuanto encuadre se acepta perder, como maximo.
   *
   * Sin tope el recorte lo decide el peor instante del clip: apoyar la camara
   * al final le impone su zoom a todo lo anterior. Con tope, ese instante se
   * corrige solo hasta donde entra.
   */
  recorteMax: number;
  /**
   * El codigo de ejes escrito a mano, para cuando el declarado no alcanza.
   *
   * Es lo unico de todo el pipeline que los datos no terminan de fijar: la
   * camara dice como estan montados sus ejes, pero no en que convencion, y una
   * convencion equivocada se ve como "se inclina y no estabiliza". Tres letras
   * cubren las 48 combinaciones posibles y se resuelve mirando la pantalla.
   */
  ejesAMano: string;
  /**
   * Un giro fijo de prueba, en grados de yaw. Es diagnostico.
   *
   * Separa dos problemas que en pantalla se ven iguales: que la correccion
   * este mal calculada, o que no llegue al visor. Si al mover esto la imagen no
   * se corre, el problema esta entre la matriz y el shader.
   */
  giroDePrueba: number;
  /**
   * Si se usa el perfil del lente cuando hay uno. Con el modelo del ojo de pez
   * la correccion en los bordes es la correcta (medido offline: el temblor
   * residual en las franjas de los bordes baja un 15-20% y el recorte baja de
   * 14% a 7%). Se deja apagar para comparar.
   */
  corregirLente: boolean;
  /**
   * Si la salida se endereza (rectas rectas, horizonte derecho) o conserva el
   * ojo de pez. Enderezar a la focal del perfil recorta la periferia (~30%
   * del cuadro); sin enderezar no se pierde encuadre. Ver Opciones.rectificar.
   */
  rectificar: boolean;
  /**
   * Si se corrige el obturador rodante cuando la camara dice cuanto tarda en
   * leerse (Sony lo escribe). Medido offline en una ZV-E10 II: sin esto el
   * temblor residual es 0.9 px arriba y 2.1 abajo; con esto, 0.7 y 1.0.
   */
  obturador: boolean;
}

/**
 * El campo horizontal por defecto cuando la camara no dice cual es.
 *
 * Medido contra el video en una HERO13 Black en 8:7 (3840x3360), modo ancho:
 * la focal que predice el movimiento de la imagen es ~1500 px, que son 104°
 * de campo horizontal. Con 120° (1108 px) la correccion quedaba un 35% corta.
 */
export const FOV_POR_DEFECTO = 104;

/** Un clip recien importado: sin estabilizar y con los valores de fabrica. */
export const AJUSTES_POR_DEFECTO: AjustesGiro = {
  activo: false,
  suavidad: 1,
  desfaseMs: 0,
  mmAMano: '',
  fovAMano: FOV_POR_DEFECTO,
  recorteMax: 30,
  ejesAMano: '',
  giroDePrueba: 0,
  corregirLente: true,
  rectificar: false,
  obturador: true,
};

/**
 * Los topes de cada deslizador. Son los mismos que muestra el panel: tenerlos
 * aca es lo que deja acotar un proyecto guardado sin duplicar los numeros.
 */
export const LIMITES_GIRO = {
  suavidad: { min: 0.02, max: 4 },
  desfaseMs: { min: -200, max: 200 },
  fovAMano: { min: 40, max: 160 },
  recorteMax: { min: 0, max: 60 },
  giroDePrueba: { min: -10, max: 10 },
} as const;

function acotar(valor: unknown, limite: { min: number; max: number }, porDefecto: number): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return porDefecto;
  return Math.min(limite.max, Math.max(limite.min, valor));
}

function comoTexto(valor: unknown, porDefecto: string): string {
  return typeof valor === 'string' ? valor : porDefecto;
}

function comoBooleano(valor: unknown, porDefecto: boolean): boolean {
  return typeof valor === 'boolean' ? valor : porDefecto;
}

/**
 * Lee unos ajustes guardados: completa lo que falte y acota el resto.
 *
 * Igual que sanearGrade: un proyecto guardado antes de que existiera la
 * estabilizacion no trae nada, y tiene que abrir en los valores de fabrica en
 * vez de meterle un undefined al calculo. Acotar ademas protege de un archivo
 * editado a mano, que es JSON y cualquiera puede tocar.
 */
export function sanearAjustes(g: Partial<AjustesGiro> | undefined): AjustesGiro {
  return {
    activo: comoBooleano(g?.activo, AJUSTES_POR_DEFECTO.activo),
    suavidad: acotar(g?.suavidad, LIMITES_GIRO.suavidad, AJUSTES_POR_DEFECTO.suavidad),
    desfaseMs: acotar(g?.desfaseMs, LIMITES_GIRO.desfaseMs, AJUSTES_POR_DEFECTO.desfaseMs),
    mmAMano: comoTexto(g?.mmAMano, AJUSTES_POR_DEFECTO.mmAMano),
    fovAMano: acotar(g?.fovAMano, LIMITES_GIRO.fovAMano, AJUSTES_POR_DEFECTO.fovAMano),
    recorteMax: acotar(g?.recorteMax, LIMITES_GIRO.recorteMax, AJUSTES_POR_DEFECTO.recorteMax),
    ejesAMano: comoTexto(g?.ejesAMano, AJUSTES_POR_DEFECTO.ejesAMano),
    giroDePrueba: acotar(g?.giroDePrueba, LIMITES_GIRO.giroDePrueba, AJUSTES_POR_DEFECTO.giroDePrueba),
    corregirLente: comoBooleano(g?.corregirLente, AJUSTES_POR_DEFECTO.corregirLente),
    rectificar: comoBooleano(g?.rectificar, AJUSTES_POR_DEFECTO.rectificar),
    obturador: comoBooleano(g?.obturador, AJUSTES_POR_DEFECTO.obturador),
  };
}
