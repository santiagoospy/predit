/**
 * Que los LUTs que trae la app esten donde el manifiesto dice y se puedan leer.
 *
 * Lee los archivos de `public/luts` de verdad, sin navegador ni fetch: lo que
 * interesa no es la mecanica de la descarga sino el contrato entre el
 * manifiesto y el disco. El error caro que atrapa esto es renombrar o mover un
 * .cube y enterarse recien en produccion, cuando todos los proyectos guardados
 * que lo usaban ya se abrieron sin color.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseCube } from './cube';
import { esDeFabrica, LUTS_FABRICA } from './fabrica';

const carpeta = fileURLToPath(new URL('../../public/luts/', import.meta.url));

describe('luts de fabrica', () => {
  it('todos los ids son unicos', () => {
    const ids = LUTS_FABRICA.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Sin el prefijo un id de fabrica podria chocar con uno del usuario, y el
  // dedupe de la subida dejaria de distinguirlos.
  it('todos los ids llevan el prefijo de fabrica', () => {
    for (const { id } of LUTS_FABRICA) {
      expect(esDeFabrica(id)).toBe(true);
    }
  });

  it('un id de usuario no pasa por de fabrica', () => {
    expect(esDeFabrica('lut1-a3f9k2')).toBe(false);
  });

  it.each(LUTS_FABRICA.map((l) => [l.name, l.archivo] as const))(
    '"%s" existe en public/luts y parsea',
    (_nombre, archivo) => {
      const texto = readFileSync(carpeta + archivo, 'utf8');
      const lut = parseCube(texto);
      // No se fija un tamano: los de fabrica son de 33 menos "slog3 santios",
      // que es de 17. Lo que importa es que la tabla este completa.
      expect(lut.size).toBeGreaterThan(1);
      expect(lut.data).toHaveLength(lut.size ** 3 * 3);
    },
  );
});
