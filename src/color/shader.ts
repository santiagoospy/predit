/**
 * Shaders del visor. Un solo programa para dos usos: el clip de abajo, que sale
 * con los dos LUTs aplicados en cadena (conversion de log a Rec.709 primero,
 * look creativo despues) y opaco; y una capa superpuesta, que sale sin LUTs y
 * con su transparencia.
 *
 * La capa no pasa por los LUTs a proposito: un logo ya esta en Rec.709, y
 * meterlo en un LUT de log a 709 le arruinaria el color.
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
  vec4 src = texture(uFrame, vUv);
  vec3 color = src.rgb;

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
