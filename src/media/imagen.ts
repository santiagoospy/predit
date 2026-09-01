/**
 * Carga una imagen para usarla como capa superpuesta.
 *
 * Va en un modulo aparte de probe.ts porque un PNG no puede pasar por probeClip:
 * esa funcion abre el archivo con mediabunny y tira UnsupportedClipError si no
 * encuentra una pista de video. Aca alcanza con createImageBitmap, que ademas
 * devuelve algo que ya sirve de textura tal cual, sin conversion intermedia.
 */

export interface ImagenCargada {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export class ImagenNoSoportadaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagenNoSoportadaError';
  }
}

export async function cargarImagen(file: File): Promise<ImagenCargada> {
  // El tipo puede venir vacio si el sistema no reconocio la extension; en ese
  // caso conviene intentar igual y dejar que falle el decodificador, que sabe
  // mas que nosotros.
  if (file.type && !file.type.startsWith('image/')) {
    throw new ImagenNoSoportadaError(
      `"${file.name}" no es una imagen. La capa tiene que ser un PNG o un WebP; ` +
        'para que se vea el video abajo, con fondo transparente.',
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      // Premultiplicado porque es lo que espera el mezclado del renderer, y
      // porque es lo que evita el halo en los bordes blandos al escalar la capa.
      premultiplyAlpha: 'premultiply',
      // El volteo tiene que pasar ACA y no al subir la textura: WebGL ignora
      // UNPACK_FLIP_Y_WEBGL cuando la fuente es un ImageBitmap, porque un
      // ImageBitmap ya viene con su orientacion resuelta. Sin esto la capa sale
      // espejada, que es lo que pasa con el origen abajo de una textura y el
      // origen arriba de una imagen.
      imageOrientation: 'flipY',
    });
  } catch (error) {
    throw new ImagenNoSoportadaError(
      `No pude abrir "${file.name}": ${error instanceof Error ? error.message : String(error)}. ` +
        'Si es un HEIC del carrete, exportalo como PNG antes de usarlo de capa.',
    );
  }

  if (bitmap.width === 0 || bitmap.height === 0) {
    bitmap.close();
    throw new ImagenNoSoportadaError(`"${file.name}" quedo en cero pixeles.`);
  }

  return { bitmap, width: bitmap.width, height: bitmap.height };
}
