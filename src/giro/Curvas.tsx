/**
 * Las tres curvas del giroscopio, dibujadas en un canvas.
 *
 * Es la prueba de que la lectura salio bien: si los datos son correctos, mover
 * la camara a la derecha tiene que dar un pico en un eje y casi nada en los
 * otros dos, y el clip quieto tiene que dar tres lineas planas. Cualquier otra
 * cosa -ruido, escalones, valores enormes- significa que el parseo esta mal, y
 * eso no se ve mirando numeros.
 *
 * Se dibuja a mano y no con una libreria de graficos porque son tres polilineas
 * y meter una dependencia por esto seria desproporcionado.
 */

import { useEffect, useRef } from 'react';

import type { MuestraGiro } from './tipos';

interface Props {
  muestras: MuestraGiro[];
  /** Donde esta el cabezal, para la linea vertical. En segundos del clip. */
  cabezal?: number;
}

/** Un color por eje, en el orden en que se dibujan. */
const EJES = [
  { nombre: 'x', color: '#c96c6c' },
  { nombre: 'y', color: '#7fa87f' },
  { nombre: 'z', color: '#5c8bb0' },
] as const;

/**
 * Cuantos puntos se dibujan como maximo.
 *
 * Un clip de un minuto a 1000 Hz son sesenta mil mediciones y el canvas tiene
 * unos pocos cientos de pixeles de ancho: dibujarlas todas es tirar trabajo a
 * la basura. Se saltean parejo, que para ver la forma de la curva alcanza.
 */
const TOPE_PUNTOS = 2000;

export function Curvas({ muestras, cabezal }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || muestras.length === 0) return;

    // El canvas se dibuja a la resolucion real de la pantalla: en el telefono
    // el CSS pixel son dos o tres fisicos y las lineas se verian borrosas.
    const dpr = window.devicePixelRatio || 1;
    const ancho = canvas.clientWidth;
    const alto = canvas.clientHeight;
    canvas.width = Math.round(ancho * dpr);
    canvas.height = Math.round(alto * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, ancho, alto);

    const t0 = muestras[0]!.segundo;
    const t1 = muestras[muestras.length - 1]!.segundo;
    const span = t1 - t0 || 1;

    // La escala vertical sale del pico real y es comun a los tres ejes: con una
    // escala por eje, un eje quieto se veria como ruido gigante.
    let pico = 0;
    for (const m of muestras) {
      pico = Math.max(pico, Math.abs(m.x), Math.abs(m.y), Math.abs(m.z));
    }
    if (pico === 0) pico = 1;

    const y = (valor: number) => alto / 2 - (valor / pico) * (alto / 2 - 4);
    const x = (segundo: number) => ((segundo - t0) / span) * ancho;

    // El cero, para poder ver de que lado esta cada curva.
    ctx.strokeStyle = 'rgba(240,240,242,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, alto / 2);
    ctx.lineTo(ancho, alto / 2);
    ctx.stroke();

    const paso = Math.max(1, Math.ceil(muestras.length / TOPE_PUNTOS));
    for (const eje of EJES) {
      ctx.strokeStyle = eje.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let primero = true;
      for (let i = 0; i < muestras.length; i += paso) {
        const m = muestras[i]!;
        const punto = y(m[eje.nombre]);
        if (primero) {
          ctx.moveTo(x(m.segundo), punto);
          primero = false;
        } else {
          ctx.lineTo(x(m.segundo), punto);
        }
      }
      ctx.stroke();
    }

    if (cabezal !== undefined && cabezal >= t0 && cabezal <= t1) {
      ctx.strokeStyle = 'rgba(240,240,242,0.55)';
      ctx.beginPath();
      ctx.moveTo(x(cabezal), 0);
      ctx.lineTo(x(cabezal), alto);
      ctx.stroke();
    }

    // El pico, arriba a la izquierda: es el numero que dice si las unidades dan
    // (un plano a mano llega a unos 100 grados por segundo; 30000 significa que
    // falto aplicar la escala).
    ctx.fillStyle = '#8a8a90';
    ctx.font = '10px monospace';
    ctx.fillText(`±${pico.toFixed(1)} °/s`, 4, 12);
  }, [muestras, cabezal]);

  return <canvas ref={canvasRef} className="giro-curvas" />;
}
