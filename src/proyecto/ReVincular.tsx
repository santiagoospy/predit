/**
 * La pantalla que pide los archivos de un proyecto guardado.
 *
 * Existe porque la app guarda la receta y no el material: al reabrir hay
 * recortes, LUTs y capas, pero no videos. En vez de dejar entrar al editor con
 * clips huecos (y tener que preguntar "y si este clip no tiene archivo?" en
 * cada rincon del visor, el arrastre y el export), la app se planta aca hasta
 * tener archivos de verdad, y recien entonces arma el montaje.
 *
 * El usuario elige todo junto y la app reparte: no hay que emparejar a mano.
 */

import { useMemo, useState } from 'react';

import type { LibraryLut } from '../edit/types';
import { formatBytes, formatDuration } from '../media/probe';
import {
  emparejar,
  faltantes,
  haceCuanto,
  resumir,
  type Faltante,
  type TipoFaltante,
} from './esquema';
import type { Pendiente } from './useProyecto';

interface Props {
  pendiente: Pendiente;
  biblioteca: LibraryLut[];
  restaurando: boolean;
  error: string | null;
  onConfirmar: (asignados: Map<string, File>) => void;
  onDescartar: () => void;
}

const ETIQUETA: Record<TipoFaltante, string> = {
  clip: 'clip',
  musica: 'música',
  capa: 'capa',
};

export function ReVincular({
  pendiente,
  biblioteca,
  restaurando,
  error,
  onConfirmar,
  onDescartar,
}: Props) {
  const { doc, motivo } = pendiente;
  const [asignados, setAsignados] = useState<Map<string, File>>(new Map());
  const [sobrantes, setSobrantes] = useState<File[]>([]);

  const pedidos = useMemo(() => faltantes(doc), [doc]);
  const resumen = useMemo(() => resumir(doc), [doc]);
  const lutsDelProyecto = useMemo(
    () => doc.luts.map((id) => biblioteca.find((l) => l.id === id)).filter((l) => l !== undefined),
    [doc.luts, biblioteca],
  );

  const recibir = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const restantes = pedidos.filter((p) => !asignados.has(p.slot));
    const resultado = emparejar(restantes, Array.from(fileList));
    setAsignados((prev) => {
      const copia = new Map(prev);
      for (const [slot, file] of resultado.asignados) copia.set(slot, file);
      return copia;
    });
    setSobrantes(resultado.sobrantes);
  };

  const clipsListos = doc.clips.filter((c) => asignados.has(c.id)).length;
  const faltanTodavia = pedidos.length - asignados.size;
  /**
   * Se abre en cuanto haya con que armar algo. Un montaje sin ningun clip no
   * tendria nada que mostrar; uno que solo tiene musica o capa (raro, pero
   * posible) se abre con eso.
   */
  const sePuedeAbrir =
    !restaurando && (doc.clips.length > 0 ? clipsListos > 0 : asignados.size > 0);

  const estado = (pedido: Faltante) => (asignados.has(pedido.slot) ? 'hay' : 'falta');

  return (
    <div className="app revincular">
      <header className="barra">
        <h1>Predit</h1>
        <span className="subtitulo">{doc.nombre}</span>
      </header>

      {motivo === 'crash' && (
        <section className="panel cartel">
          <p className="comentario">se cortó la sesión</p>
          <p>
            Quedó un montaje sin cerrar de {haceCuanto(doc.actualizado)}: {resumen.clips} clip
            {resumen.clips === 1 ? '' : 's'} · {formatDuration(resumen.duracionSeconds)}. Elegí los
            archivos para retomarlo donde estaba.
          </p>
        </section>
      )}

      <section className="panel">
        <div className="fila">
          <span className="comentario">
            {motivo === 'abrir' ? 'abriendo' : 'retomando'} · {resumen.clips} clip
            {resumen.clips === 1 ? '' : 's'} · {formatDuration(resumen.duracionSeconds)}
          </span>
        </div>

        <p className="nota">
          /* los recortes, el color y la capa ya están guardados; los archivos de video no */
        </p>

        <ul className="faltantes">
          {pedidos.map((pedido) => (
            <li key={pedido.slot} className={estado(pedido)}>
              <span className="marca">{asignados.has(pedido.slot) ? '✓' : '·'}</span>
              <span className="nombre">{pedido.huella.nombre}</span>
              <span className="detalle">
                {pedido.tipo === 'clip' ? formatBytes(pedido.huella.tamano) : ETIQUETA[pedido.tipo]}
              </span>
            </li>
          ))}
        </ul>

        <label className={`importar${restaurando ? ' ocupado' : ''}`}>
          {faltanTodavia === pedidos.length ? '+ elegir los archivos' : '+ elegir los que faltan'}
          <input
            type="file"
            multiple
            disabled={restaurando}
            onChange={(e) => {
              recibir(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <small>
          Podés elegirlos en varias tandas: el selector del teléfono no deja mezclar Fotos y
          Archivos de una sola vez.
        </small>

        {sobrantes.length > 0 && (
          <p className="aviso">
            {sobrantes.length === 1
              ? `"${sobrantes[0]?.name}" no es ninguno de los que faltan.`
              : `${sobrantes.length} de los archivos que elegiste no son ninguno de los que faltan.`}
          </p>
        )}

        {lutsDelProyecto.length > 0 && (
          <p className="listo">
            LUTs ya cargados: {lutsDelProyecto.map((l) => l.name).join(', ')}
          </p>
        )}
        {doc.luts.length > lutsDelProyecto.length && (
          <p className="aviso">
            Este montaje usaba {doc.luts.length - lutsDelProyecto.length} LUT
            {doc.luts.length - lutsDelProyecto.length === 1 ? '' : 's'} que ya no está en la
            biblioteca: esos clips van a entrar sin LUT.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        <button
          className="principal grande"
          disabled={!sePuedeAbrir}
          onClick={() => onConfirmar(asignados)}
        >
          {restaurando
            ? 'abriendo el montaje…'
            : clipsListos === 0
              ? 'abrir el montaje →'
              : faltanTodavia === 0
                ? `abrir el montaje · ${clipsListos} clip${clipsListos === 1 ? '' : 's'} →`
                : `abrir con ${clipsListos} de ${doc.clips.length} clips →`}
        </button>

        {faltanTodavia > 0 && clipsListos > 0 && (
          <p className="aviso">
            Los {faltanTodavia} que falten quedan afuera del montaje. Si los conseguís después, hay
            que volver a importarlos a mano.
          </p>
        )}

        <button className="chico" disabled={restaurando} onClick={onDescartar}>
          {motivo === 'crash' ? 'descartar' : 'empezar de cero'}
        </button>
      </section>
    </div>
  );
}
