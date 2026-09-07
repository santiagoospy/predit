# Estabilización por giroscopio — estado y contexto

Documento de traspaso. Lo que sigue es lo que costó averiguar, no lo que se lee
en el código: los formatos de cámara, las convenciones, y sobre todo los cuatro
bugs que ya se encontraron, con su síntoma, para no volver a caer en ellos.

Estado al commit `c26ac8c`. 268 tests en verde.

---

## Qué hace y qué falta

**Funciona y está verificado con clips reales:**

- Leer el giroscopio de Sony (FX30, ZV-E10 II, FX3…) y de GoPro.
- Las curvas de diagnóstico en la pestaña *clip*.
- La óptica: focal de Sony desde la metadata; campo de visión a mano para GoPro.
- La corrección aplicada al visor en vivo, con interruptor y deslizadores.

**Falta:**

- **Confirmar que estabiliza de verdad.** El último cambio (`c26ac8c`) todavía
  no lo probó el usuario. Todo lo anterior a él sí estaba roto.
- **Guardar los ajustes en el proyecto.** Hoy viven en el estado de `PanelGiro`
  y se pierden al cambiar de pestaña o cerrar. Van en `ClipDoc` (`esquema.ts`).
- **Aplicarlo al exportar.** Hoy es solo preview; `exporter.ts` no sabe nada.
- **Enderezar el horizonte de GoPro** (la curvatura del ojo de pez).

---

## El mapa de archivos

Todo en `src/giro/`:

| Archivo | Qué resuelve |
|---|---|
| `mp4.ts` | Camina las cajas del MP4 hasta la pista de metadata. **Necesario** porque mediabunny solo expone video, audio y subtítulos. |
| `sony.ts` | Parser RTMD: giroscopio, escala, ejes y óptica. |
| `gopro.ts` | Parser GPMF: giroscopio, unidades, ejes, modelo y calibración de lente. |
| `leer.ts` | Elige el parser por el formato de la pista (`rtmd` / `gpmd`). |
| `tipos.ts` | `MuestraGiro`, `DatosGiro`, `Optica`, `ModeloRadial`. |
| `quat.ts` | Cuaterniones. |
| `estabilizar.ts` | Integrar → suavizar → corregir → recortar. El núcleo. |
| `Curvas.tsx` | Las tres curvas en un canvas. |
| `PanelGiro.tsx` | Dueño de todo el camino: lee, arma la corrección y se la pasa al visor. |

Fuera de `giro/`: el warp vive en `color/shader.ts` (uniforms `uEstab` /
`uHayEstab`, en el **fragment**, deformando el muestreo) y `color/renderer.ts`
(`setEstabilizacion`). `App.tsx` guarda la corrección en `estabRef` y pide la
matriz por cuadro en el bucle de dibujo.

---

## Lo que costó averiguar

### mediabunny no sirve para esto

Solo entrega pistas de video, audio y subtítulos. El giroscopio vive en una
pista de tipo `meta` que ninguna API del navegador expone. De ahí `mp4.ts`.

### Sony (RTMD)

Tags, sacados de `telemetry-parser` (`src/sony/rtmd_tags.rs`) — no hay
documentación pública de Sony:

| Tag | Qué es |
|---|---|
| `0xe435` | Frecuencia del giroscopio (Hz) |
| `0xe438` | Unidad de la escala: `false` = °/s, `true` = rad/s |
| `0xe439` | Escala (divisor) |
| `0xe43a` | Orientación de los ejes |
| `0xe43b` | Los datos: cantidad, largo (6), y ternas de int16 |
| `0xe410` | Posición del lente; la **z** es la focal en nm — grupo `LensOSS` |
| `0xe407` | Tamaño del píxel — grupo `Imager` |
| `0xe40a` | Recorte del sensor — grupo `Imager` |

**El detalle que importa:** la focal la escribe el LENTE, el tamaño del píxel y
el recorte los escribe la CÁMARA. Con un lente manual falta solo la focal.

`anchoSensorMm = tamañoPíxel × anchoRecorte` sale siempre, y es **mejor que un
menú APS-C/full frame**: ya trae adentro el modo de recorte (un cuerpo full
frame en Super35 lee 23 mm, no 36), el recorte del formato y el modo de lectura.
Por eso el usuario solo carga los mm del barril.

### GoPro (GPMF)

Formato autodescriptivo: `FourCC` + tipo + tamaño + cantidad + datos, alineado a
4 bytes. No hace falta conocer tags de antemano.

- `GYRO` + `SCAL` (divisor) dentro del mismo `STRM`.
- **`SIUN`/`UNIT` traen la unidad, y GoPro guarda rad/s.** Hay que multiplicar
  por 180/π.
- `ORIN` = orden y signo de los ejes.
- `DVNM` = modelo.
- `CORI` = orientación de la cámara **ya integrada por GoPro**, en cuaterniones.
- `GRAV` = vector de gravedad.

**Calibración de lente** (`POLY`, `ZMPL`, `VRES`, `ZFOV`, `VFOV`, `ARUW`/`ARWA`):
el código la lee y calcula `focal = mediaDiagonal / (r1 · ZMPL · factor)`, pero
**la cámara del usuario NO la escribe** — se verificó listando las claves del
archivo. Es una función de modelos/firmwares recientes. Cuando no está, la focal
sale del deslizador de campo horizontal.

Claves que sí trae esa cámara, por si sirven:

```
AALP ACCL CORI CSCM DVID DVNM EMPT FACE GRAV HUES IORI ISOE LOGS LRVO
LRVS LSKP MSKP MWET ORIN PRJT SCAL SCEN SHUT SIUN STMP STNM TMPC TSMP
TYPE UNIF UNIT WBAL WNDM WRGB YAVG
```

### La cadena de ejes (`ORIN` / `0xe43a`)

Se lee de **una sola forma**, y es fácil leerla al revés. La fuente es
`orient()` en `telemetry-parser/src/tags_impl.rs`:

```rust
Vector3 { x: map(io[0]), y: map(io[1]), z: map(io[2]) }   // map('Z') → self.z
```

Cada letra dice, **para el eje de salida de esa posición**, de qué canal
guardado sale. En `"ZXY"`: el eje X toma el canal `z`, el Y toma el `x`, el Z
toma el `y`. Minúscula = negar.

La lectura opuesta ("el canal 0 va al eje Z") es la permutación inversa. Ver
bug 3.

---

## Los cuatro bugs que ya se encontraron

Cada uno tenía un síntoma en pantalla distinto. Vale la pena conocerlos porque
los síntomas se repiten.

### 1. GoPro en radianes → «no veo ninguna diferencia»

No se convertía rad/s a °/s, así que los valores entraban **57 veces más
chicos**. No era un error visible: la estabilización funcionaba, no rompía la
imagen, no temblaba — simplemente corregía tan poco que parecía apagada.

*La pista:* el pico de las curvas daba ±8.6 °/s en una GoPro caminando, contra
±90 °/s en la Sony con el mismo tipo de movimiento.

### 2. Corrección invertida → «tiembla el doble»

La rotación de muestreo es `inv(R_real) · R_suave`. Estaba calculado el producto
al revés **y encima** invertido de nuevo al armar la matriz.

*Lección de testing, la más importante de todas:* los 33 tests que había no lo
veían, porque todos comprobaban que la matriz fuera coherente **consigo misma**
(que las esquinas entraran, que el UV coincidiera con los píxeles) y eso se
cumple igual con la corrección invertida. El test que lo detecta mira el
**mundo**: fija un punto lejano y mide cuánto se mueve la dirección que ve el
píxel del centro. Estabilizar tiene que achicar ese número; invertida, lo
duplica.

### 3. `ORIN` leído como la permutación inversa → «se inclina y no estabiliza»

Cruzaba los tres ejes. En pantalla: la imagen se inclina un poco (el roll hace
algo) pero el temblor no se cancela, porque cada eje compensa el movimiento de
otro.

### 4. Recorte por cuadro → «todas las combinaciones se ven iguales»

El peor de los cuatro, y el más instructivo. Cuando el temblor pide más recorte
del disponible hay que corregir de menos. Se estaba acotando **cada cuadro por
separado**, dejando el máximo que entrara en cada uno. Eso satura todos los
cuadros contra el mismo tope: la corrección deja de ser proporcional al temblor
y **el tope tapa las diferencias**, así que cambiar los ejes, la suavidad o
cualquier cosa daba siempre lo mismo.

*Cómo se encontró:* simulando el clip y midiendo el desplazamiento del centro.
Daba **34.9 px idéntico** con suavidad 0.5 y con 1.5. Escalando todo por un
factor global (que conserva la forma) da 24.8 y 28.2.

*El dato que salió de ahí:* sacar todo el temblor de un clip caminando cuesta
**~45% de recorte**. No es un bug, es física. Por eso el tope por defecto es 30%
y el panel muestra a qué porcentaje se está corrigiendo (`ganancia`).

---

## Lo que todavía no está confirmado

**La convención de ejes de GoPro.** La cámara declara cómo están montados
(`ORIN`), pero no en qué marco de referencia, y eso los datos no lo fijan. Por
eso `PanelGiro` tiene un campo de texto de tres letras precargado con lo
declarado: cubre las 48 combinaciones y se resuelve mirando la pantalla.

Cuando se confirme cuál funciona, conviene dejarla fija por marca y sacar el
campo (o esconderlo).

**Plan B si sigue sin salir:** GoPro escribe `CORI`, la orientación ya integrada
y fusionada por la cámara. Usarla en vez de integrar el giroscopio saltea todo
el problema de ejes y además no acumula deriva. `GRAV` (gravedad) permitiría
además nivelar el horizonte.

---

## Cómo se prueba

```bash
npm run dev        # UN solo proceso: varios vite a la vez saturan el watcher
npm test
```

En la app: pestaña **clip** → *leer el giroscopio de este clip* → tildar
*estabilizar este clip*.

Los números del panel y qué detecta cada uno:

| Fila | Qué está mal si no da |
|---|---|
| frecuencia medida | 200–2000 Hz. Si da ~25, se lee una medición por cuadro y se pierde el resto. |
| abarca | Tiene que dar casi igual a la duración del clip. |
| pico ±°/s (en la curva) | A mano difícilmente pase de 200 en Sony. ~500 en GoPro caminando. Si da 30000, falta aplicar la escala. |
| focal | De dónde salió: *de la cámara*, *a mano* o *del campo a ojo*. |
| ejes declarados | Lo que dice `ORIN`. |
| ganancia (`al X%`) | Menos de 100% = el recorte no alcanza para corregir todo. |

Para material caminando conviene **bajar la suavidad** (0.2s) antes que subir el
recorte: saca el temblor rápido y cuesta mucho menos encuadre.
