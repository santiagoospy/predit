import { describe, expect, it } from 'vitest';
import { CubeParseError, parseCube, sampleLut, type Lut3D } from './cube';

/** Genera el texto .cube de un LUT identidad de lado n. */
function identityCubeText(n: number): string {
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
      }
    }
  }
  return lines.join('\n');
}

describe('parseCube', () => {
  it('lee un LUT identidad y respeta el orden (el rojo varia mas rapido)', () => {
    const lut = parseCube(identityCubeText(2));
    expect(lut.size).toBe(2);
    expect(lut.data.length).toBe(2 * 2 * 2 * 3);
    // Segunda entrada: r=1, g=0, b=0
    expect(Array.from(lut.data.slice(3, 6))).toEqual([1, 0, 0]);
    // Tercera entrada: r=0, g=1, b=0
    expect(Array.from(lut.data.slice(6, 9))).toEqual([0, 1, 0]);
    // Quinta entrada: r=0, g=0, b=1
    expect(Array.from(lut.data.slice(12, 15))).toEqual([0, 0, 1]);
  });

  it('lee TITLE, comentarios de linea y comentarios al final de linea', () => {
    const text = [
      '# LUT de prueba',
      'TITLE "S-Log3 a Rec.709"',
      '',
      'LUT_3D_SIZE 2   # el tamano mas chico posible',
      identityCubeText(2).split('\n').slice(1).join('\n'),
    ].join('\n');
    const lut = parseCube(text);
    expect(lut.title).toBe('S-Log3 a Rec.709');
    expect(lut.size).toBe(2);
  });

  it('respeta DOMAIN_MIN y DOMAIN_MAX', () => {
    const text = ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 2 2', identityCubeText(2)].join('\n');
    const lut = parseCube(text);
    expect(lut.domainMax).toEqual([2, 2, 2]);
    // Con dominio 0..2, la entrada 1.0 cae en el medio del LUT.
    expect(sampleLut(lut, 1, 1, 1)[0]).toBeCloseTo(0.5, 6);
  });

  it('ignora palabras clave de fabricante que no conoce', () => {
    const text = ['LUT_3D_INPUT_RANGE 0.0 1.0', identityCubeText(2)].join('\n');
    expect(parseCube(text).size).toBe(2);
  });

  it('rechaza un LUT 1D con un mensaje que explica por que', () => {
    expect(() => parseCube('LUT_1D_SIZE 32\n0 0 0')).toThrow(CubeParseError);
    expect(() => parseCube('LUT_1D_SIZE 32\n0 0 0')).toThrow(/LUT 1D/);
  });

  it('rechaza un archivo al que le faltan entradas', () => {
    const text = identityCubeText(2).split('\n').slice(0, -1).join('\n');
    expect(() => parseCube(text)).toThrow(/incompleto/);
  });

  it('rechaza un archivo con entradas de mas', () => {
    const text = identityCubeText(2) + '\n0.5 0.5 0.5';
    expect(() => parseCube(text)).toThrow(/mas entradas/);
  });

  it('rechaza datos antes de LUT_3D_SIZE', () => {
    expect(() => parseCube('0.1 0.2 0.3\nLUT_3D_SIZE 2')).toThrow(/antes de LUT_3D_SIZE/);
  });

  it('rechaza un archivo que no es un .cube 3D', () => {
    expect(() => parseCube('hola\nmundo')).toThrow(/no parece un archivo \.cube 3D/);
  });

  it('rechaza valores no numericos', () => {
    const text = 'LUT_3D_SIZE 2\n' + Array(8).fill('0 0 nan!').join('\n');
    expect(() => parseCube(text)).toThrow(/no es un numero/);
  });

  it('rechaza un dominio invertido', () => {
    const text = ['DOMAIN_MIN 1 0 0', 'DOMAIN_MAX 0 1 1', identityCubeText(2)].join('\n');
    expect(() => parseCube(text)).toThrow(/DOMAIN_MAX tiene que ser mayor/);
  });
});

describe('sampleLut', () => {
  const identity = parseCube(identityCubeText(17));

  it('el LUT identidad devuelve el color sin tocar', () => {
    for (const c of [0, 0.25, 0.5, 0.751, 1]) {
      const [r, g, b] = sampleLut(identity, c, c, c);
      expect(r).toBeCloseTo(c, 5);
      expect(g).toBeCloseTo(c, 5);
      expect(b).toBeCloseTo(c, 5);
    }
  });

  it('interpola linealmente entre nodos', () => {
    // LUT 2x2x2 que duplica el rojo: en el nodo r=1 vale 1, y en r=0 vale 0,
    // asi que en r=0.5 tiene que dar 0.5 exacto.
    const lut = parseCube(identityCubeText(2));
    expect(sampleLut(lut, 0.5, 0, 0)[0]).toBeCloseTo(0.5, 6);
    expect(sampleLut(lut, 0.25, 0, 0)[0]).toBeCloseTo(0.25, 6);
  });

  it('recorta los valores fuera del dominio en vez de extrapolar', () => {
    expect(sampleLut(identity, -0.5, 0, 0)[0]).toBeCloseTo(0, 6);
    expect(sampleLut(identity, 1.5, 0, 0)[0]).toBeCloseTo(1, 6);
  });

  it('mezcla los tres canales en el orden correcto', () => {
    // LUT que intercambia rojo y azul.
    const n = 2;
    const lines = [`LUT_3D_SIZE ${n}`];
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          lines.push(`${b} ${g} ${r}`);
        }
      }
    }
    const swap: Lut3D = parseCube(lines.join('\n'));
    const [outR, outG, outB] = sampleLut(swap, 1, 0, 0);
    expect(outR).toBeCloseTo(0, 6);
    expect(outG).toBeCloseTo(0, 6);
    expect(outB).toBeCloseTo(1, 6);
  });
});
