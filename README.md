# predit

https://predit-812.netlify.app/

PWA para cortar, aplicar LUTs y exportar clips de video directamente desde el teléfono — pensada
para editar en viaje, sin computadora, con clips de cámaras distintas (probado con los proxies de la Sony FX6, GoPro) que después se terminan de editar en apps como Edits de Instagram.

Corre entera en el navegador: no hay backend ni servidor de procesamiento. Todo el color y la
codificación de video pasan por WebGL2 y WebCodecs, así que anda offline una vez instalada.

## Qué hace

- Importa varios clips de una vez, de cualquier cámara.
- Un **LUT por clip** (conversión de log a Rec.709, más un LUT de look opcional encima), porque
  cada cámara suele grabar con su propio perfil de color y mezclarlas con un solo LUT global no
  funciona.
- Biblioteca de LUTs reutilizable: subís cada `.cube` una sola vez.
- Recorte y velocidad por clip, con un modo "conformar" para cámara lenta limpia sin inventar ni
  perder cuadros.
- Reencuadre por arrastre (llenar y recortar, o entero con bandas), sin deformar la imagen.
- **Audio**: el MP4 sale con el sonido propio de cada clip (volumen por clip) y una pista de música
  encima. La música puede ser un `.mp3`, `.m4a` o `.wav` importado, o el audio extraído de cualquiera
  de los videos que ya cargaste. Al reproducir un clip, la música suena desde el segundo que le toca
  en la línea de tiempo, así se escucha lo que va a quedar en el corte final.
- Ordenás los clips y exportás **un solo MP4**, en horizontal, vertical 9:16 o UHD.
- **Se guarda solo**: el montaje se autoguarda mientras editás y se le puede poner nombre para
  tener varios proyectos. Si el teléfono cierra la app o se cae el navegador, al volver a abrirla
  te ofrece retomar donde ibas.

## Una limitación importante

Los archivos **MXF nativos de la Sony FX6 (XAVC-I) no se pueden abrir en el navegador** — es H.264
High 4:2:2 10-bit, un perfil que ningún navegador de teléfono decodifica por hardware. La app
trabaja con los **proxies MP4** que la cámara graba al lado del MXF (activá "Proxy Rec" en la FX6;
en modo S&Q, la propia cámara desactiva el proxy, así que para cámara lenta conviene grabar el
proyecto a 50p y usar el botón "Conformar" en la app).

## Dos detalles del audio

El sonido propio de un clip **se silencia si el clip tiene la velocidad cambiada**: estirar el audio
junto con la imagen lo desafina (voz grave en cámara lenta). La música sigue sonando igual, y el
clip queda con imagen lenta y sin sonido directo.

El navegador puede **leer** MP3 pero **no escribirlo** — no existe un encoder MP3 en WebCodecs — así
que el MP4 exportado lleva AAC. Si el dispositivo no puede codificar audio, el video se exporta igual
y la app avisa que salió mudo.

## Qué se guarda y qué no

Se guarda la **receta** del montaje —los recortes, las velocidades, el reencuadre, qué LUT usa cada
clip, la música y la capa con sus tiempos—, que son unos pocos KB. **Los videos no se copian**: ya
están en el teléfono y duplicarlos llenaría la cuota del navegador con varios GB.

El precio es que al reabrir un proyecto hay que volver a elegir los archivos. No hay que
emparejarlos a mano: se eligen todos juntos y la app los reconoce por nombre, tamaño y fecha, y cada
uno vuelve a su lugar con su recorte intacto. Si algún archivo no aparece, el montaje entra igual
sin ese clip.

La **biblioteca de LUTs sí queda guardada entera**, porque un `.cube` pesa medio mega y tener que
volver a subir el de cada cámara en cada sesión sería justo lo que la biblioteca vino a evitar.

Todo vive en el IndexedDB del propio navegador: no hay cuenta ni servidor, y borrar los datos del
sitio borra los proyectos.

## Uso

Abrí la URL publicada en Safari (iPhone) o Chrome (Android), y en el menú de compartir elegí
"Agregar a pantalla de inicio". Queda instalada como app, funciona sin conexión.

## Desarrollo local

```bash
npm install
npm run dev -- --host   # --host para probar desde el celular en la misma red
npm test
npm run build
```

## Stack

Vite + React + TypeScript, sin backend. [`mediabunny`](https://mediabunny.dev/) para demux/mux de
MP4 y como capa sobre WebCodecs. El color se resuelve con un shader propio en WebGL2 (textura 3D en
media precisión para los LUTs). La mezcla de audio se arma en un `OfflineAudioContext` de Web Audio.
`vite-plugin-pwa` para el manifest y el service worker.

## Licencia

MIT — ver [`LICENSE`](./LICENSE).
