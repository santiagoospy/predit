/**
 * El panel de proyectos: el nombre, el guardado y la lista de lo guardado.
 *
 * El autoguardado ya corre solo, asi que aca no hay ningun boton de "guardar":
 * lo unico que agrega ponerle nombre es sacarlo de "el proyecto en el que estoy"
 * y fijarlo en la lista para poder volver.
 */

import { useState } from 'react';

import { formatDuration } from '../media/probe';
import { haceCuanto, horaCorta, NOMBRE_SIN_TITULO, type ResumenProyecto } from './esquema';

interface Props {
  nombre: string;
  guardadoEn: number | null;
  lista: ResumenProyecto[];
  deshabilitado: boolean;
  /** Si hay algo en el editor que se perderia al abrir otra cosa. */
  hayMontaje: boolean;
  onGuardarComo: (nombre: string) => void;
  onAbrir: (id: string) => void;
  onBorrar: (id: string) => void;
  onNuevo: () => void;
  /** Relee la lista al desplegarla, que es la unica vez que se mira. */
  onRefrescar: () => void;
}

export function PanelProyecto({
  nombre,
  guardadoEn,
  lista,
  deshabilitado,
  hayMontaje,
  onGuardarComo,
  onAbrir,
  onBorrar,
  onNuevo,
  onRefrescar,
}: Props) {
  const [nombrando, setNombrando] = useState(false);
  const [abriendo, setAbriendo] = useState(false);
  const [borrador, setBorrador] = useState('');

  const sinNombre = nombre === NOMBRE_SIN_TITULO;

  /**
   * Un montaje sin nombre solo vive en la sesion: si se abre otra cosa encima,
   * no hay forma de volver a el. Con nombre esta en la lista y no se pierde.
   */
  const confirmarSalida = (): boolean => {
    if (!hayMontaje || !sinNombre) return true;
    return window.confirm(
      'El montaje actual no tiene nombre, así que no va a quedar en la lista. ¿Seguir igual?',
    );
  };

  const confirmarNombre = () => {
    const limpio = borrador.trim();
    if (limpio === '') return;
    onGuardarComo(limpio);
    setNombrando(false);
    setBorrador('');
  };

  return (
    <section className="panel">
      <div className="fila">
        <span className="comentario">proyecto</span>
        <span className="etiqueta">
          {nombre}
          {guardadoEn !== null && ` · guardado ${horaCorta(guardadoEn)}`}
        </span>
      </div>

      <div className="botones par">
        <button
          className={nombrando ? 'activo chico' : 'chico'}
          disabled={deshabilitado}
          onClick={() => {
            setBorrador(sinNombre ? '' : nombre);
            setNombrando((v) => !v);
            setAbriendo(false);
          }}
        >
          guardar como…
        </button>
        <button
          className={abriendo ? 'activo chico' : 'chico'}
          disabled={deshabilitado || lista.length === 0}
          onClick={() => {
            if (!abriendo) onRefrescar();
            setAbriendo((v) => !v);
            setNombrando(false);
          }}
        >
          abrir… ({lista.length})
        </button>
        <button
          className="chico"
          disabled={deshabilitado || !hayMontaje}
          onClick={() => {
            if (confirmarSalida()) onNuevo();
          }}
        >
          nuevo
        </button>
      </div>

      {nombrando && (
        <div className="fila nombrar">
          <input
            type="text"
            value={borrador}
            autoFocus
            placeholder="nombre del proyecto"
            maxLength={60}
            onChange={(e) => setBorrador(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmarNombre();
              if (e.key === 'Escape') setNombrando(false);
            }}
          />
          <button className="chico" disabled={borrador.trim() === ''} onClick={confirmarNombre}>
            guardar
          </button>
        </div>
      )}

      {abriendo && (
        <ul className="proyecto-lista">
          {lista.map((p) => (
            <li key={p.id}>
              <button
                className="proyecto-abrir"
                onClick={() => {
                  if (!confirmarSalida()) return;
                  setAbriendo(false);
                  onAbrir(p.id);
                }}
              >
                <span className="nombre">{p.nombre}</span>
                <span className="detalle">
                  {haceCuanto(p.actualizado)} · {p.clips} clip{p.clips === 1 ? '' : 's'} ·{' '}
                  {formatDuration(p.duracionSeconds)}
                </span>
              </button>
              <button
                className="chico"
                title={`Borra "${p.nombre}" de la lista`}
                onClick={() => {
                  if (window.confirm(`¿Borrar el proyecto "${p.nombre}"?`)) onBorrar(p.id);
                }}
              >
                borrar
              </button>
            </li>
          ))}
        </ul>
      )}

      <small>
        Se guarda el montaje, no los videos: al reabrir un proyecto hay que volver a elegir los
        archivos, y la app los reconoce solos.
      </small>
    </section>
  );
}
