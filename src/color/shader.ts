/**
 * Shaders del visor. Un solo programa para dos usos: el clip de abajo, que sale
 * con su correccion primaria (lift, gamma, gain) y los dos LUTs aplicados en
 * cadena (conversion de log a Rec.709 primero, look creativo despues), opaco; y
 * una capa superpuesta, que sale sin nada de eso y con su transparencia.
 *
 * La capa no pasa ni por el grade ni por los LUTs a proposito: un logo ya esta
 * en Rec.709, y meterlo en un LUT de log a 709 le arruinaria el color.
 */

export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
uniform mat3 uTransform;   // encuadre: escala, recorte y desplazamiento del clip
out vec2 vUv;

void main() {
  // aPos va de -1 a 1. El UV sale de la posicion sin transformar.
  vUv = aPos * 0.5 + 0.5;
  vec3 p = uTransform * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uFrame;

/**
 * La correccion de la estabilizacion, en coordenadas de textura.
 *
 * Lleva un punto de la imagen de SALIDA al punto de la imagen de ENTRADA que
 * hay que muestrear. Sale de la rotacion que midio el giroscopio: la camara
 * temblo, y esto deshace ese temblor moviendo lo que se lee de la textura.
 *
 * Va en el fragment y no en el vertex porque no es una transformacion del
 * cuadrilatero sino del muestreo: la geometria del encuadre ya la resuelve
 * uTransform, y son dos cosas distintas que se componen.
 */
uniform mat3 uEstab;
uniform bool uHayEstab;

/**
 * El obturador rodante (ver Opciones.tiempoDeLectura en giro/estabilizar.ts).
 * El sensor se lee de arriba a abajo, asi que cada fila de la ENTRADA se
 * expuso en un instante distinto y tiene su propia correccion. Con
 * uHayLectura, uEstab es la de la primera fila y uEstabAbajo la de la ultima;
 * entre las dos se interpola linealmente por la fila de entrada. Como esa fila
 * no se conoce hasta muestrear, se hace dos veces: con la fila de salida, y
 * con la fila de entrada que dio la primera (igual que Gyroflow).
 */
uniform bool uHayLectura;
uniform mat3 uEstabAbajo;

/** La matriz de muestreo de una fila (0 = arriba, 1 = abajo). */
mat3 estabEn(float fila) {
  return uHayLectura ? uEstab + (uEstabAbajo - uEstab) * fila : uEstab;
}

/**
 * El modelo del lente, cuando hay perfil (ver giro/lente.ts, que es la
 * referencia de estas cuentas). Con lente, uEstab no es la homografia sino la
 * ROTACION de muestreo, y la cadena se hace entera aca, en pixeles de la
 * imagen completa: pixel de salida -> rayo -> rotar -> proyectar con el
 * modelo de ojo de pez -> pixel de entrada.
 *
 * La cuenta va en pixeles y no en UV porque el modelo esta calibrado en
 * pixeles; el tamano llega en uTamano y se normaliza al final. La V de la
 * textura crece hacia ARRIBA (el video se sube con UNPACK_FLIP_Y_WEBGL), asi
 * que se da vuelta al entrar y al salir.
 */
uniform bool  uHayLente;
uniform vec2  uLenteF;      // fx, fy de la entrada
uniform vec2  uLenteC;      // cx, cy
uniform vec4  uLenteK;      // k1..k4
uniform float uFocalSalida; // focal de la salida, ya con el zoom
uniform bool  uRectificar;  // salida rectilinea (true) u ojo de pez (false)
uniform vec2  uTamano;      // ancho, alto en pixeles

/** theta_d(theta): el polinomio del ojo de pez de OpenCV. */
float lenteThetaD(float theta) {
  float t2 = theta * theta;
  return theta * (1.0 + t2 * (uLenteK.x + t2 * (uLenteK.y + t2 * (uLenteK.z + t2 * uLenteK.w))));
}

/** De un rayo (x derecha, y abajo, z adelante) al pixel del ojo de pez. */
vec2 lenteProyectar(vec3 v) {
  // Hacia atras no hay imagen: un punto lejos, que el clamp deja en el borde.
  if (v.z <= 1e-9) return vec2(-1e9);
  vec2 ab = v.xy / v.z;
  float r = length(ab);
  float theta = atan(r);
  float escala = r > 1e-9 ? lenteThetaD(theta) / r : 1.0;
  return uLenteF * ab * escala + uLenteC;
}

/**
 * La inversa, para la salida sin rectificar: del pixel al rayo, con Newton
 * sobre el polinomio (mismos pasos que desproyectarLente en giro/lente.ts).
 */
vec3 lenteDesproyectar(vec2 px, vec2 f) {
  vec2 ab = (px - uLenteC) / f;
  float rd = length(ab);
  if (rd < 1e-9) return vec3(0.0, 0.0, 1.0);
  float theta = rd;
  for (int i = 0; i < 6; i++) {
    float t2 = theta * theta;
    float g = lenteThetaD(theta) - rd;
    float dg = 1.0 + t2 * (3.0 * uLenteK.x + t2 * (5.0 * uLenteK.y + t2 * (7.0 * uLenteK.z + t2 * 9.0 * uLenteK.w)));
    theta -= g / dg;
  }
  theta = clamp(theta, 0.0, 1.5697963);
  return vec3(ab * (tan(theta) / rd), 1.0);
}

/** El muestreo con lente: de UV de salida a UV de entrada. */
vec2 muestreoConLente(vec2 uv) {
  vec2 px = vec2(uv.x * uTamano.x, (1.0 - uv.y) * uTamano.y);
  vec3 v;
  if (uRectificar) {
    v = vec3((px - uTamano * 0.5) / uFocalSalida, 1.0);
  } else {
    // La salida es el mismo ojo de pez, con la focal escalada por el zoom.
    v = lenteDesproyectar(px, vec2(uFocalSalida, uFocalSalida * uLenteF.y / uLenteF.x));
  }
  // px esta en pixeles con la y hacia abajo: fila 0 es arriba.
  float fila = uHayLectura ? clamp(px.y / uTamano.y, 0.0, 1.0) : 0.5;
  vec2 q = lenteProyectar(estabEn(fila) * v);
  if (uHayLectura) {
    fila = clamp(q.y / uTamano.y, 0.0, 1.0);
    q = lenteProyectar(estabEn(fila) * v);
  }
  return vec2(q.x / uTamano.x, 1.0 - q.y / uTamano.y);
}

/** Cuanto se ve la capa, de 0 a 1. El clip de abajo siempre va en 1. */
uniform float uOpacity;
/** Si respetar la transparencia de la textura. El clip de abajo es opaco. */
uniform bool  uUsarAlfa;

uniform sampler3D uLutConv;
uniform bool  uHasConv;
uniform float uSizeConv;
uniform vec3  uDomMinConv;
uniform vec3  uDomMaxConv;

uniform sampler3D uLutLook;
uniform bool  uHasLook;
uniform float uSizeLook;
uniform vec3  uDomMinLook;
uniform vec3  uDomMaxLook;

/**
 * Correccion primaria del clip, ANTES de los LUTs: lift, gamma y gain.
 *
 * En vec3 y no en float aunque hoy la UI mueva las tres perillas parejas: el dia
 * que se quiera corregir una dominante por canal R/G/B, el shader ya esta.
 *
 * La misma cuenta, en CPU, esta en color/grade.ts. Si cambia una tiene que
 * cambiar la otra.
 */
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;

/**
 * Lee un LUT 3D con interpolacion trilineal por hardware.
 *
 * El +0.5/size es lo que evita que el color mienta: una textura 3D de lado N
 * tiene sus valores en el CENTRO de cada texel, no en el borde. Sin ese ajuste
 * el LUT queda corrido medio texel y las sombras y las luces se van de lugar.
 */
vec3 applyLut(sampler3D lut, float size, vec3 domMin, vec3 domMax, vec3 color) {
  vec3 norm = clamp((color - domMin) / (domMax - domMin), 0.0, 1.0);
  vec3 coord = (norm * (size - 1.0) + 0.5) / size;
  return texture(lut, coord).rgb;
}

void main() {
  vec2 uv = vUv;
  if (uHayLente) {
    uv = muestreoConLente(vUv);
  } else if (uHayEstab) {
    // La V crece hacia arriba, asi que la fila (0 = arriba) es 1 - v.
    float fila = uHayLectura ? 1.0 - vUv.y : 0.5;
    vec3 p = estabEn(fila) * vec3(vUv, 1.0);
    if (uHayLectura) {
      fila = clamp(1.0 - p.y / p.z, 0.0, 1.0);
      p = estabEn(fila) * vec3(vUv, 1.0);
    }
    // La division de perspectiva: una rotacion de camara no es una traslacion
    // plana, y sin dividir por w los bordes quedarian corridos.
    uv = p.xy / p.z;
  }

  vec4 src = texture(uFrame, uv);
  vec3 color = src.rgb;

  // El grade va antes de los LUTs: sobre la senal cruda, todavia en log.
  // Lift pivotado en el blanco, y max(color, 0) porque pow() de un negativo
  // (que un lift negativo produce en los negros) devuelve NaN.
  color = color + uLift * (1.0 - color);
  color = pow(max(color, vec3(0.0)), 1.0 / uGamma);
  color = color * uGain;

  if (uHasConv) {
    color = applyLut(uLutConv, uSizeConv, uDomMinConv, uDomMaxConv, color);
  }
  if (uHasLook) {
    color = applyLut(uLutLook, uSizeLook, uDomMinLook, uDomMaxLook, color);
  }

  if (uUsarAlfa) {
    // Alfa premultiplicado: el color YA viene multiplicado por su alfa, asi que
    // la opacidad tiene que pegarle a los dos por igual. Premultiplicado y no
    // directo porque, al escalar la capa, el filtrado bilineal de un PNG
    // directo deja un halo en los bordes blandos.
    fragColor = vec4(color * uOpacity, src.a * uOpacity);
  } else {
    fragColor = vec4(color, 1.0);
  }
}
`;
