/**
 * Las cuentas de reordenar la tira, aparte del componente que las dibuja: son
 * aritmetica sobre las cajas de los chips y asi se pueden probar sin navegador.
 */

/**
 * La caja de un chip, en coordenadas de contenido de la tira -o sea, contando
 * lo que la tira ya tenga scrolleado-. Asi el mapa no se mueve si la tira se
 * corre sola mientras se arrastra.
 */
export interface Caja {
  left: number;
  width: number;
}

function centroDe(caja: Caja): number {
  return caja.left + caja.width / 2;
}

/**
 * Mueve un elemento de lugar corriendo al resto. No es un intercambio: sacar el
 * tercero y ponerlo primero deja 3,1,2 y no 3,2,1, que es lo que uno espera al
 * arrastrar un clip hasta el principio del montaje.
 */
export function moverEnLista<T>(lista: readonly T[], desde: number, hasta: number): T[] {
  const copia = lista.slice();
  if (desde < 0 || desde >= lista.length) return copia;
  const destino = Math.min(lista.length - 1, Math.max(0, hasta));
  if (destino === desde) return copia;
  const [movido] = copia.splice(desde, 1);
  copia.splice(destino, 0, movido as T);
  return copia;
}

/**
 * En que lugar quedaria el chip que se esta arrastrando, segun donde cayo su
 * centro.
 *
 * La cuenta se hace siempre contra las cajas ORIGINALES, las de antes de
 * empezar: los chips se corren en pantalla para abrir el hueco, pero si el mapa
 * se recalculara con ellos ya movidos el destino oscilaria entre dos valores y
 * el chip temblaria abajo del dedo.
 */
export function destinoDelArrastre(
  centroArrastrado: number,
  cajas: readonly Caja[],
  desde: number,
): number {
  const propia = cajas[desde];
  if (!propia) return desde;

  if (centroArrastrado < centroDe(propia)) {
    // Yendo a la izquierda: el primer chip cuyo centro ya quedo pasado.
    for (let j = 0; j < desde; j++) {
      if (centroArrastrado < centroDe(cajas[j]!)) return j;
    }
  } else {
    // Yendo a la derecha: el ultimo chip cuyo centro ya quedo pasado.
    for (let j = cajas.length - 1; j > desde; j--) {
      if (centroArrastrado > centroDe(cajas[j]!)) return j;
    }
  }
  return desde;
}

/**
 * Cuanto se corre en pantalla un chip que NO es el arrastrado, para abrir el
 * hueco. Solo se mueven los que quedan entre el origen y el destino, y siempre
 * un lugar: el ancho del chip que se saco, mas la separacion de la tira.
 */
export function desplazamientoDe(
  indice: number,
  desde: number,
  destino: number,
  cajas: readonly Caja[],
  gap: number,
): number {
  if (indice === desde) return 0;
  const paso = (cajas[desde]?.width ?? 0) + gap;
  if (destino > desde && indice > desde && indice <= destino) return -paso;
  if (destino < desde && indice >= destino && indice < desde) return paso;
  return 0;
}

/**
 * Donde aterriza el chip arrastrado. Al soltar se lo baja hasta aca con una
 * transicion en vez de dejarlo saltar de golpe desde donde quedo el dedo.
 */
export function offsetDelSlot(cajas: readonly Caja[], desde: number, destino: number): number {
  const origen = cajas[desde];
  const llegada = cajas[destino];
  if (!origen || !llegada) return 0;
  // Yendo a la derecha el chip queda alineado por su borde derecho con el ultimo
  // que paso; yendo a la izquierda, por el izquierdo del que desplazo.
  if (destino > desde) return llegada.left + llegada.width - origen.width - origen.left;
  return llegada.left - origen.left;
}
