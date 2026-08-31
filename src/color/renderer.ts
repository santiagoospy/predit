import type { Lut3D } from './cube';
import { createLutTexture } from './lutTexture';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader';

export type LutSlot = 'conv' | 'look';
export type FitMode = 'cover' | 'contain';

interface LoadedLut {
  tex: WebGLTexture;
  size: number;
  domainMin: readonly [number, number, number];
  domainMax: readonly [number, number, number];
}

export interface Framing {
  /** Dimensiones de lo que hay EN la textura, antes de rotar. */
  textureWidth: number;
  textureHeight: number;
  /**
   * Rotacion horaria que todavia hay que aplicar (0, 90, 180 o 270).
   *
   * Ojo con la asimetria: un <video> ya viene rotado por el navegador, asi que
   * el visor pasa 0. Un VideoFrame de WebCodecs NO viene rotado, asi que el
   * export tiene que pasar la rotacion que declara el archivo.
   */
  rotation?: number;
  mode: FitMode;
  /** -1 a 1: hacia donde corre el recorte cuando sobra imagen. 0 es centrado. */
  panX?: number;
  panY?: number;
}

/**
 * Dibuja un cuadro de video en un canvas aplicando dos LUTs en cadena.
 *
 * La fuente puede ser un <video> (el camino del visor, donde decodifica el
 * hardware de iOS) o un VideoFrame de WebCodecs (el camino del export, donde
 * hace falta exactitud de cuadro).
 */
export class LutRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly frameTex: WebGLTexture;
  private readonly loc: Record<string, WebGLUniformLocation | null> = {};
  private readonly luts: Record<LutSlot, LoadedLut | null> = { conv: null, look: null };
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error('Este dispositivo no soporta WebGL2, que la app necesita para los LUTs.');
    }
    this.gl = gl;

    this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    gl.useProgram(this.program);

    const uniformNames = [
      'uTransform', 'uFrame',
      'uLutConv', 'uHasConv', 'uSizeConv', 'uDomMinConv', 'uDomMaxConv',
      'uLutLook', 'uHasLook', 'uSizeLook', 'uDomMinLook', 'uDomMaxLook',
    ];
    for (const name of uniformNames) {
      this.loc[name] = gl.getUniformLocation(this.program, name);
    }

    gl.uniform1i(this.loc['uFrame']!, 0);
    gl.uniform1i(this.loc['uLutConv']!, 1);
    gl.uniform1i(this.loc['uLutLook']!, 2);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('No se pudo crear el VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Un cuadrado, no un triangulo grande: al rotar el encuadre el triangulo
    // dejaria de cubrir el lienzo en algunos angulos.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    if (!tex) throw new Error('No se pudo crear la textura del cuadro');
    this.frameTex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Carga (o quita, con null) uno de los dos LUTs. */
  setLut(slot: LutSlot, lut: Lut3D | null): void {
    this.assertAlive();
    const previous = this.luts[slot];
    if (previous) this.gl.deleteTexture(previous.tex);

    this.luts[slot] = lut
      ? {
          tex: createLutTexture(this.gl, lut),
          size: lut.size,
          domainMin: lut.domainMin,
          domainMax: lut.domainMax,
        }
      : null;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * @param bypass Dibuja el cuadro crudo, sin LUTs. Sirve para comparar antes y
   *   despues sin tener que volver a subir las texturas a la GPU.
   */
  draw(source: TexImageSource, framing: Framing, bypass = false): void {
    this.assertAlive();
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    // El origen de una textura WebGL esta abajo; el de un video, arriba.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.bindLut('conv', gl.TEXTURE1, 'Conv', bypass);
    this.bindLut('look', gl.TEXTURE2, 'Look', bypass);

    gl.uniformMatrix3fv(
      this.loc['uTransform']!,
      false,
      computeFitTransform(framing, this.canvas.width, this.canvas.height),
    );

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Lee el lienzo como RGBA. Se usa para comparar contra ffmpeg en los tests. */
  readPixels(): Uint8Array {
    this.assertAlive();
    const { width, height } = this.canvas;
    const pixels = new Uint8Array(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose(): void {
    if (this.disposed) return;
    const gl = this.gl;
    for (const slot of ['conv', 'look'] as const) {
      const lut = this.luts[slot];
      if (lut) gl.deleteTexture(lut.tex);
      this.luts[slot] = null;
    }
    gl.deleteTexture(this.frameTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    this.disposed = true;
  }

  private bindLut(slot: LutSlot, unit: number, suffix: string, bypass: boolean): void {
    const gl = this.gl;
    const lut = bypass ? null : this.luts[slot];
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_3D, lut ? lut.tex : null);
    gl.uniform1i(this.loc['uHas' + suffix]!, lut ? 1 : 0);
    if (lut) {
      gl.uniform1f(this.loc['uSize' + suffix]!, lut.size);
      gl.uniform3f(this.loc['uDomMin' + suffix]!, ...lut.domainMin);
      gl.uniform3f(this.loc['uDomMax' + suffix]!, ...lut.domainMax);
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('El renderer ya fue liberado');
  }
}

/**
 * Calcula como entra el clip en el lienzo respetando su relacion de aspecto.
 *
 * En 'cover' el clip se agranda hasta llenar y lo que sobra se recorta; es lo que
 * hace falta al exportar vertical 9:16 desde material apaisado. En 'contain'
 * entra entero y quedan bandas negras.
 */
export function computeFitTransform(
  framing: Framing,
  canvasWidth: number,
  canvasHeight: number,
): Float32Array {
  const { textureWidth: tw, textureHeight: th } = framing;
  const rotation = normalizeRotation(framing.rotation);
  const { k, overflowX, overflowY } = computeFit(framing, canvasWidth, canvasHeight);

  // M = (pixeles a NDC con el ajuste de encaje) * (rotacion) * (forma de la textura)
  const cos = Math.round(Math.cos((rotation * Math.PI) / 180));
  const sin = Math.round(Math.sin((rotation * Math.PI) / 180));
  const nx = (2 * k) / canvasWidth;
  const ny = (2 * k) / canvasHeight;
  const hw = tw / 2;
  const hh = th / 2;

  // Rotacion horaria: (x, y) -> (x*cos + y*sin, -x*sin + y*cos)
  const m00 = nx * cos * hw;
  const m01 = nx * sin * hh;
  const m10 = -ny * sin * hw;
  const m11 = ny * cos * hh;

  // Solo se puede desplazar lo que sobra; si no sobra nada, el pan no hace nada.
  const tx = clamp(framing.panX ?? 0, -1, 1) * overflowX;
  const ty = clamp(framing.panY ?? 0, -1, 1) * overflowY;

  // mat3 en orden por columnas, que es lo que espera uniformMatrix3fv.
  return new Float32Array([m00, m10, 0, m01, m11, 0, tx, ty, 1]);
}

export interface FitResult {
  /** Factor de escala uniforme. Es el MISMO para los dos ejes: la imagen nunca se estira. */
  k: number;
  /** Cuanta imagen sobra de cada lado, en unidades de semieje del lienzo. 0 = no sobra nada. */
  overflowX: number;
  overflowY: number;
}

/**
 * Cuanto material sobra fuera del lienzo, que es exactamente lo que se puede
 * reencuadrar. Si da 0 en un eje, arrastrar en esa direccion no hace nada y la
 * interfaz no deberia ofrecerlo.
 */
export function computeFit(
  framing: Framing,
  canvasWidth: number,
  canvasHeight: number,
): FitResult {
  const rotation = normalizeRotation(framing.rotation);
  const quarterTurn = rotation === 90 || rotation === 270;

  // Dimensiones que ocupa la imagen una vez rotada.
  const displayWidth = quarterTurn ? framing.textureHeight : framing.textureWidth;
  const displayHeight = quarterTurn ? framing.textureWidth : framing.textureHeight;

  const scaleX = canvasWidth / displayWidth;
  const scaleY = canvasHeight / displayHeight;
  // 'contain' entra entera y deja bandas; 'cover' llena y recorta lo que sobra.
  // En los dos casos el factor es unico, asi que la proporcion se respeta.
  const k = framing.mode === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  return {
    k,
    overflowX: Math.max((k * displayWidth) / canvasWidth - 1, 0),
    overflowY: Math.max((k * displayHeight) / canvasHeight - 1, 0),
  };
}

function normalizeRotation(degrees: number | undefined): number {
  const r = ((Math.round((degrees ?? 0) / 90) * 90) % 360 + 360) % 360;
  return r;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error('No se pudo crear el programa de WebGL');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Fallo el enlazado del shader: ${log}`);
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('No se pudo crear el shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Fallo la compilacion del shader: ${log}`);
  }
  return shader;
}
