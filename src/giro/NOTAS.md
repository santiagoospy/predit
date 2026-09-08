# Estabilización por giroscopio — estado y contexto

Documento de traspaso. Lo que sigue es lo que costó averiguar, no lo que se lee
en el código: los formatos de cámara, las convenciones, y sobre todo los ocho
bugs que ya se encontraron, con su síntoma, para no volver a caer en ellos.

Estado al 2026-09-07 (después de `f51e6ba`, sin commitear). 280 tests en verde.

---

## Qué hace y qué falta

**Funciona y está verificado con clips reales:**

- Leer el giroscopio de Sony (FX30, ZV-E10 II, FX3…) y de GoPro.
- Las curvas de diagnóstico en la pestaña *clip*.
- La óptica: focal de Sony desde la metadata; campo de visión a mano para GoPro.
- La corrección aplicada al visor en vivo, con interruptor y deslizadores.

**Falta:**

- **Confirmar que estabiliza de verdad.** Los bugs 5 y 6 (abajo) se
  arreglaron el 2026-09-07 y el usuario todavía no probó con ellos. Todo lo
  anterior estaba roto por el bug 5, así que **ninguna prueba de ejes hecha
  antes vale**: había que repetirlas.
- **Calibrar contra el video** (el plan nuevo, abajo): es lo que saca la
  adivinanza de ejes, focal y desfase.
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

### La cadena de ejes: la cadena completa de Gyroflow

Nadie documenta en qué marco están los ejes del giroscopio. La única referencia
que estabiliza clips reales es Gyroflow, así que se copió **toda** su cadena,
paso a paso y con la fuente de cada uno (verificado el 2026-09-07 leyendo el
código en GitHub):

1. **De dónde sale la cadena.**
   - GoPro (`telemetry-parser/src/gopro/mod.rs`): si hay `MTRX`, la cadena
     sale de la matriz (`mtrx_to_orientation`). Si no, se arma la matriz con
     `ORIN` **y** `ORIO` (`orientations_to_matrix`). **Con `ORIN` sola no arma
     nada** y Gyroflow cae a `"XYZ"`. La HERO 13 del usuario escribe `ORIN`
     pero no `ORIO` ni `MTRX`, así que el mapeo es el de `"XYZ"`. Ojo: la
     cadena que sale de ORIN+ORIO es la permutación **inversa** de ORIN.
   - Sony: el tag `0xe43a`, y después `normalize_imu_orientation()`
     (`sony/mod.rs`) **intercambia las posiciones 0 y 1 e invierte el signo de
     la tercera**.
2. **`orient()`** (`tags_impl.rs`): la letra de la posición i dice de qué
   canal sale la componente i. Minúscula = negar.
3. **Integración** (`gyroflow/src/core/imu_integration/mod.rs`,
   `SimpleGyroIntegrator`): `omega = (-g[1], g[0], g[2])`. La componente 1 es
   el pitch, la 0 el yaw, la 2 el roll, en un marco con la **y hacia arriba y
   la z hacia atrás**.
4. **Al marco de la imagen** (`stabilization/frame_transform.rs`): conjuga la
   rotación con `diag(1, -1, -1)` (y con `diag(1, 1, -1)` si el framebuffer
   está invertido: es nuestro bug 5, ellos lo tienen contemplado).

Resultado en nuestro marco (x derecha, y abajo, z adelante):
**pitch = -g[1], yaw = -g[0], roll = -g[2]**. Es lo que hace
`mapeoDesdeOrientacion(cadena, fuente)`. Si el signo global está al revés se ve
como "tiembla el doble en todo" y la corrección es pasar las tres letras a
minúscula en el campo del panel; si eso pasa, hay que dar vuelta el signo en el
código y anotarlo acá.

---

## Los ocho bugs que ya se encontraron

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

### 5. La V de la textura crece hacia arriba → «lo vertical y la inclinación tiemblan el doble»

El renderer sube el video con `UNPACK_FLIP_Y_WEBGL`, así que en el shader
`v = 0` es el borde de **abajo**. `aEspacioUv` asumía `v = y/alto` con la y
hacia abajo. Conjugar una rotación con un espejo vertical **invierte el pitch y
el roll y deja el yaw**: los paneos horizontales se corregían y lo demás se
duplicaba.

*Por qué no se vio antes:* el test «da el mismo punto que la matriz en píxeles»
comparaba contra la misma suposición. Ahora compara contra `1 - y/alto` y hay
un test de cabeceo puro que exige que el uv se mueva al revés que los píxeles.

*Lección:* con este bug abajo, **toda** prueba de ejes a ojo era inútil, porque
ninguna combinación de letras puede compensar un espejo.

### 6. La cadena de ejes leída con otra convención que Gyroflow

`mapeoDesdeOrientacion` hacía posición 0 = pitch, 1 = yaw. Gyroflow hace
1 = pitch, 0 = yaw (y niega todo al pasar al marco de la imagen). Además, para
GoPro se usaba `ORIN` sola, que Gyroflow **no** usa (ver arriba). Arreglado
copiando la cadena de Gyroflow completa y leyendo `MTRX` u `ORIN`+`ORIO` del
stream del `GYRO`.

### 7. Ganancia global → «da igual qué letras ponga, no estabiliza»

El arreglo del bug 4 escalaba TODA la corrección por un número. En un clip
real (GX010389, 152 s) los últimos cuatro segundos son alguien agarrando la
cámara (pico 842 °/s) y piden más del doble de zoom; con el tope en 30% la
ganancia global bajaba a **30% para los 148 segundos anteriores**. Un temblor
de 2° corregido al 30% es 0.6°: invisible, con cualquier mapeo de ejes.

*Cómo se encontró:* corriendo el parser y `prepararEstabilizacion` sobre el
archivo real desde Node (`_diag.test.ts`, sin trackear, corre con
`LOG=... CLIPS=GX010389.MP4 ALTO=3360 npx vitest run src/giro/_diag.test.ts`).

*El arreglo:* la ganancia es una **curva en el tiempo** (`curvaDeGanancia`):
ganancia máxima por cuadro → filtro de mínimo en una ventana de 0.5 s →
suavizado ida y vuelta → clamp al máximo por cuadro. Un limitador con attack y
release, no un fader. Y el zoom lo decide el percentil 90 de los cuadros, no el
peor, salvo que todo entre en el tope. En el clip real: ganancia 1.00 en el
cuerpo, baja a 0.6 en dos paneos y a 0.1 en el golpe; zoom 20% en vez de 30%.

*Lección:* las dos lecciones anteriores valen a la vez. Acotar por cuadro
satura (bug 4); escalar todo deja que un golpe apague el clip (bug 7). Lo que
sirve es local **y** suave.

---

## Lo que se confirmó contra el video (2026-09-07)

Se hizo la calibración offline: cuadros del clip GX010389 extraídos con ffmpeg
a 240×210 en gris, flujo global por Lucas-Kanade piramidal (dx, dy, rotación),
y contra eso la predicción de las 48 combinaciones de ejes con desfases de
−160 a +160 ms. Está en `_calibrar.test.ts` (sin trackear; ver ahí cómo
correrlo). Resultado en dos tramos distintos del clip:

| | tramo 20–35 s | tramo 70–82 s |
|---|---|---|
| mapeo ganador | **el de Gyroflow** (pitch=−y, yaw=−x, roll=−z) | el mismo |
| correlación dx / dy / rot | 0.99 / 0.83 / 0.85 | 0.97 / 0.60 / 0.80 |
| desfase | +10 ms | +10 ms |
| focal medida | ~1470 px | ~1540 px |

O sea: **los ejes están bien, el signo global está bien, y el reloj del
giroscopio coincide con el del video.** Lo que estaba mal:

- **La focal por defecto.** 120° de campo (1108 px) contra ~1500 px medidos:
  la corrección quedaba un 35% corta. El defecto pasó a 104°. Es de ESTA cámara
  en ESTE modo (8:7, ancho); la calibración en la app (paso 4) lo va a medir
  por clip.
- **El instante del cuadro en el visor** (bug 8, abajo).

Lo que sí se confirmó a ojo antes de eso: la matriz llega al shader (con el
deslizador «prueba: girar» la imagen se corre).

### 8. `video.currentTime` no es el cuadro que está en pantalla → «se ve peor que sin estabilizar»

El bucle de dibujo pedía la corrección para `video.currentTime`. Ese es el
reloj de reproducción, no el instante del cuadro decodificado: difieren uno o
dos cuadros (40–80 ms) y cambian de a saltos. Un temblor de caminar tiene 5–10
Hz, así que 60 ms es media fase o más: la corrección se aplica con la fase
equivocada y **suma** temblor. Con la calibración demostrando que los ejes y el
reloj del giroscopio están bien, era el único candidato que quedaba.

*El arreglo:* `requestVideoFrameCallback` en paralelo al rAF, solo para anotar
`mediaTime` del último cuadro presentado (`tiempoCuadroRef` en `App.tsx`). En
pausa se sigue usando `currentTime`, que ahí sí es exacto.

*Probado por el usuario:* con esto **sigue viéndose igual** (solo el recorte).
Lo que sigue explica por qué, medido.

---

## El banco de pruebas offline y lo que midió (2026-09-07, noche)

`_verificar.test.ts` (sin trackear) aplica NUESTRA `prepararEstabilizacion` a
los cuadros reales extraídos con ffmpeg y mide con el mismo flujo óptico cuánto
movimiento queda. Reproduce lo que ve el usuario sin necesidad del navegador.
Se corre así (los `.raw` salen de ffmpeg, ver `_calibrar.test.ts`):

```
LOG=... SEG=.../seg20.raw INICIO=20 FOCAL=1704 SUAV=1,2 REF=0,15 DESF=0.01 ZOOM=1.3 \
  npx vitest run src/giro/_verificar.test.ts
```

Lo que salió, sobre el tramo 20–35 s de GX010389 (incluye un giro de 170°):

- **La dirección es correcta.** Con el mapeo de Gyroflow y desfase +10 ms el
  temblor rápido baja (horizontal 1.3→0.6 px/cuadro, vertical 2.7→1.0,
  rotación 0.099→0.02°). Con los tres signos invertidos empeora 3×. Con
  desfase 0 o +20 ms es peor que con +10: **el instante correcto del cuadro es
  ~10 ms después de su timestamp**, no el timestamp (el defecto del deslizador
  debería ser +10 ms; hoy es 0).
- **El temblor rápido de este material es minúsculo:** 1 a 3 px por cuadro en
  4K, o sea medio píxel en el visor. Corregirlo no se ve. Lo que se ve moverse
  son 3–7 px/cuadro de **balanceo lento** (caminar) y el giro de 170°.
- **El balanceo lento lo bajamos solo a la mitad** (dx 3–7 → 2–4, dy 3–5 →
  1–2), con cualquier suavidad. Y la suavidad larga con filtro fijo colapsa la
  ganancia en el giro (suavidad 4 s → ganancia 0.25).
- **El suavizado adaptativo a la velocidad** (`velocidadDeReferencia`, nuevo en
  `suavizar`) arregla lo segundo: con referencia 15 °/s y suavidad 1–2 s la
  ganancia se queda en 1.00 durante el giro. Quedó como defecto (15).
- El perfil de lente de Gyroflow para esta cámara (`GX010389.gyroflow`,
  `GoPro_HERO11 Black_Wide_8by7`): **f = 1704 px**, centro (1935, 1677),
  fisheye k = [0.0314, 0.0597, −0.0434, 0.0099]. La focal medida por flujo
  global (~1500) es menor porque el ojo de pez comprime los bordes.

**Por qué Gyroflow se ve "super bien" y esto no, hipótesis en orden:**

1. **Distorsión de lente.** Sin modelo de ojo de pez, la misma rotación mueve
   los bordes menos que el centro; la corrección de agujero de alfiler sobre
   una imagen de ojo de pez deja residuo en toda la periferia, y además la
   imagen de Gyroflow sale *rectificada*, que ya de por sí se ve más limpia.
   Tenemos los coeficientes exactos en el `.gyroflow`. Es el paso siguiente.
2. **Traslación.** Caminar mueve la cámara, no solo la gira; la paralaje sobre
   lo cercano es movimiento que ningún giroscopio ve. Gyroflow tampoco lo
   corrige, pero lo disimula con la rectificación y el zoom adaptativo.
3. **Obturador rodante.** No modelado. Gyroflow tiene `frame_readout_time`
   (en este perfil no está seteado, así que probablemente pese poco).

**Plan B si sigue sin salir:** GoPro escribe `CORI`, la orientación ya integrada
y fusionada por la cámara. Usarla en vez de integrar el giroscopio saltea todo
el problema de ejes y además no acumula deriva. `GRAV` (gravedad) permitiría
además nivelar el horizonte.

---

## El plan nuevo: calibrar contra el video

**Actualización:** los pasos 3 y 4 ya existen en versión offline
(`_calibrar.test.ts`, `_verificar.test.ts`) y dieron su veredicto: ejes,
signo y reloj están bien. Antes de portarlos a la app conviene atacar la
**distorsión de lente** (hipótesis 1 de arriba): leer los coeficientes de un
perfil de Gyroflow (o los `POLY`/`ZMPL` del archivo cuando la cámara los
escribe) y hacer el muestreo del shader con el modelo de ojo de pez:
salida rectificada → rayo → rotar → proyectar con el modelo de la lente →
píxel de entrada.

Acordado el 2026-09-07. La idea: **dejar de adivinar**. El propio clip dice
cómo se mueve la imagen, y con eso se fijan ejes, signos, focal y desfase de
una vez (es el "autosync" de Gyroflow). Pasos 1 y 2 hechos; siguen:

3. **Medir el movimiento real de la imagen** (`flujo.ts`). Ya existe la
   versión offline en `_calibrar.test.ts`: portar ese Lucas-Kanade. Decodificar con
   mediabunny (como `exporter.ts`) unos 3-5 s del clip a ~128x72 en gris.
   Entre cuadros consecutivos estimar dx, dy y rotación con Lucas-Kanade
   global sobre la mitad izquierda y la derecha (si una sube y la otra baja,
   es roll). Ojo con la rotación del clip: WebCodecs entrega el cuadro sin
   rotar.
4. **Autocalibrar** (`calibrar.ts`). Correlacionar dx, dy y rotación contra
   cada canal +-, promediados por cuadro. Elegir la asignación con mejor
   correlación; el tercer signo sale del determinante (sistema derecho). La
   pendiente dx/yaw da la **focal en píxeles** (reemplaza el deslizador de
   campo horizontal en GoPro). Barrer el **desfase** en +-150 ms. Devolver un
   coeficiente de calidad.
5. **UI:** botón «calibrar con el video» en `PanelGiro` que muestra y aplica
   ejes, focal, desfase y calidad. El campo de tres letras queda como override.
6. **Métrica objetiva:** correr el flujo también sobre la salida estabilizada
   y mostrar temblor antes / después en píxeles.

Después, en este orden: guardar en `ClipDoc`, aplicar en el export, horizonte
de GoPro con `GRAV`.

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
| ejes declarados | La cadena como la armaría Gyroflow (`MTRX` u `ORIN`+`ORIO`), o «XYZ como Gyroflow» si la cámara no la escribe completa. |
| entero en el X% del clip | Qué parte del clip se corrige (casi) completa. Bajo = hay golpes o paneos que piden más que el tope. |
| ahora: pitch · yaw · roll · ganancia | La corrección en el cabezal. Tienen que moverse con el temblor. |
| prueba: girar | Diagnóstico: un yaw fijo. Si la imagen no se corre, la matriz no llega al shader. |

Para material caminando conviene **bajar la suavidad** (0.2s) antes que subir el
recorte: saca el temblor rápido y cuesta mucho menos encuadre.
