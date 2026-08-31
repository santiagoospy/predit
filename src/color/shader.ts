/**
 * Shaders del visor. Un solo paso: el cuadro entra, sale con los dos LUTs
 * aplicados en cadena (conversion de log a Rec.709 primero, look creativo despues).
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
  vec3 color = texture(uFrame, vUv).rgb;

  if (uHasConv) {
    color = applyLut(uLutConv, uSizeConv, uDomMinConv, uDomMaxConv, color);
  }
  if (uHasLook) {
    color = applyLut(uLutLook, uSizeLook, uDomMinLook, uDomMaxLook, color);
  }

  fragColor = vec4(color, 1.0);
}
`;
