/**
 * El deslizador de toda la app: etiqueta, barra y el valor ya formateado.
 *
 * Vive aparte de App porque lo usan tanto los controles del clip como el panel
 * del giroscopio, y tenerlo en App obligaria a un import circular.
 */
export function Deslizador({
  etiqueta,
  valor,
  min = 0,
  max,
  paso,
  onChange,
  texto,
  deshabilitado,
}: {
  etiqueta: string;
  valor: number;
  min?: number;
  max: number;
  paso?: number;
  onChange: (valor: number) => void;
  texto: string;
  deshabilitado?: boolean;
}) {
  return (
    <label className={`deslizador${deshabilitado ? ' apagado' : ''}`}>
      <span className="comentario">{etiqueta}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={paso ?? 0.01}
        value={valor}
        disabled={deshabilitado ?? false}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="valor">{texto}</span>
    </label>
  );
}
