/**
 * Correccion primaria por clip: lift, gamma y gain, ANTES de los LUTs.
 *
 * Va antes a proposito. En ese punto el color todavia esta en log (el shader no
 * lineariza nada: trabaja sobre el codigo 0..1 que entrega el decodificador), asi
 * que estas tres perillas son el equivalente al nodo previo al LUT que arma un
 * colorista en set: se acomoda la exposicion y el contraste del material crudo, y
 * recien despues el LUT lo lleva a Rec.709. Corregir DESPUES del LUT seria pelear
 * contra una curva ya aplicada y quemar las luces mucho antes.
 *
 * Ojo con la intuicion: sobre log, el lift se parece a un desplazamiento de
 * exposicion y el gain pega sobre todo en el contraste de las sombras. No se
 * sienten igual que las mismas perillas en Rec.709.
 *
 * La cuenta vive aca, en una funcion pura, y no solo en el GLSL, por el mismo
 * motivo que sampleLut() en cube.ts: es la unica forma de testear el color sin
 * GPU, y de encadenar grade + LUT en CPU para comprobar que las dos mitades del
 * pipeline dicen lo mismo.
 */

export interface Grade {
  /** Levanta o hunde los negros sin mover el blanco. 0 = neutro. */
  lift: number;
  /** Curva los medios dejando los extremos quietos. 1 = neutro. */
  gamma: number;
  /** Multiplica todo. 1 = neutro. */
  gain: number;
}

export const GRADE_NEUTRO: Grade = { lift: 0, gamma: 1, gain: 1 };

/**
 * Los topes de cada perilla. Los usa la UI para armar los deslizadores y
 * sanearGrade para acotar lo que venga de un proyecto guardado.
 *
 * Son rangos cortos a proposito: esto empareja tomas, no reinventa el color, y
 * en un telefono el recorrido del dedo es el que es.
 */
export const LIMITES = {
  lift: { min: -0.3, max: 0.3, paso: 0.01 },
  gamma: { min: 0.4, max: 2.5, paso: 0.01 },
  gain: { min: 0.4, max: 2.5, paso: 0.01 },
} as const;

/** Si el clip no tiene nada tocado. Sirve para esconder el boton de reset. */
export function esNeutro(g: Grade): boolean {
  return g.lift === GRADE_NEUTRO.lift && g.gamma === GRADE_NEUTRO.gamma && g.gain === GRADE_NEUTRO.gain;
}

/**
 * Lee un grade guardado: completa lo que falte con el neutro y acota el resto.
 *
 * Los defaults tolerantes son lo que deja abrir un proyecto guardado antes de que
 * existieran estos campos sin tener que subir la version del documento. Y no es
 * solo prolijidad: un undefined llegando a gl.uniform3f pinta NaN en la GPU, o sea
 * pantalla negra sin ningun error en la consola.
 */
export function sanearGrade(g: Partial<Grade> | undefined): Grade {
  return {
    lift: acotar(g?.lift, LIMITES.lift, GRADE_NEUTRO.lift),
    gamma: acotar(g?.gamma, LIMITES.gamma, GRADE_NEUTRO.gamma),
    gain: acotar(g?.gain, LIMITES.gain, GRADE_NEUTRO.gain),
  };
}

/**
 * Espejo exacto de lo que hace el fragment shader. Si una de las dos cambia, la
 * otra tiene que cambiar igual.
 */
export function applyGrade(
  rgb: readonly [number, number, number],
  g: Grade,
): [number, number, number] {
  return [aplicarCanal(rgb[0], g), aplicarCanal(rgb[1], g), aplicarCanal(rgb[2], g)];
}

function aplicarCanal(c: number, g: Grade): number {
  // Lift pivotado en el blanco: el negro sube lo que diga la perilla y el blanco
  // no se mueve. Es lo que uno espera de la palabra "lift"; un offset plano
  // subiria tambien las luces y seria otra cosa.
  let v = c + g.lift * (1 - c);
  // El max(v, 0) no es prolijidad: con lift negativo el valor se va abajo de cero
  // y Math.pow (como pow() en GLSL) de un negativo devuelve NaN.
  v = Math.pow(Math.max(v, 0), 1 / g.gamma);
  return v * g.gain;
  // No se clampea arriba: applyLut() ya acota contra el dominio del LUT, asi que
  // un gain agresivo clipea las luces ahi, que es justo lo que se espera.
}

function acotar(valor: number | undefined, limite: { min: number; max: number }, neutro: number): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return neutro;
  return Math.min(limite.max, Math.max(limite.min, valor));
}
