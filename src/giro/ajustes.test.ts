import { describe, expect, it } from 'vitest';

import { AJUSTES_POR_DEFECTO, sanearAjustes, type AjustesGiro } from './ajustes';

describe('sanearAjustes', () => {
  it('un proyecto de antes de que existiera la estabilizacion abre en fabrica', () => {
    expect(sanearAjustes(undefined)).toEqual(AJUSTES_POR_DEFECTO);
  });

  it('completa los campos que falten sin tocar los que vinieron', () => {
    const leido = sanearAjustes({ activo: true, suavidad: 2.5 });
    expect(leido.activo).toBe(true);
    expect(leido.suavidad).toBe(2.5);
    // El resto queda como de fabrica, no en undefined.
    expect(leido.recorteMax).toBe(AJUSTES_POR_DEFECTO.recorteMax);
    expect(leido.corregirLente).toBe(AJUSTES_POR_DEFECTO.corregirLente);
  });

  it('acota lo que se haya editado a mano en el JSON', () => {
    const leido = sanearAjustes({ suavidad: 99, desfaseMs: -5000, recorteMax: 200 });
    expect(leido.suavidad).toBe(4);
    expect(leido.desfaseMs).toBe(-200);
    expect(leido.recorteMax).toBe(60);
  });

  it('ignora los tipos que no son, sin romperse', () => {
    const basura = { suavidad: 'mucha', activo: 1, ejesAMano: null } as unknown as Partial<AjustesGiro>;
    expect(sanearAjustes(basura)).toEqual(AJUSTES_POR_DEFECTO);
  });

  it('deja pasar entero lo que guardo la app', () => {
    const ajustes: AjustesGiro = {
      activo: true,
      suavidad: 0.5,
      desfaseMs: -40,
      mmAMano: '24',
      fovAMano: 120,
      recorteMax: 15,
      ejesAMano: 'YxZ',
      giroDePrueba: 0,
      corregirLente: false,
      rectificar: true,
      obturador: false,
    };
    expect(sanearAjustes(JSON.parse(JSON.stringify(ajustes)))).toEqual(ajustes);
  });
});
