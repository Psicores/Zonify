# Zonify

Recordatorios de tareas basados en ubicación (geocercas) para iOS y Android.

**Stack:** Expo SDK 58 · React Native 0.88 · TypeScript · expo-sqlite + Drizzle ORM.
La app usa un *development build* (no Expo Go), porque las épicas siguientes necesitan
ubicación en background y módulos nativos.

## Requisitos

| Plataforma | Requisitos |
| --- | --- |
| Común | Node ≥ 20 (probado con 24) |
| Android local | JDK 17, Android SDK + emulador o dispositivo con depuración USB (`ANDROID_HOME` configurado) |
| iOS local | macOS con Xcode y CocoaPods |
| Sin toolchain nativo | Cuenta de Expo y `npx eas-cli@latest` para compilar en la nube |

## Primeros pasos

```bash
npm install

# Compilar e instalar el dev build y arrancar Metro
npm run android        # expo run:android
npm run ios            # expo run:ios (solo macOS)

# Alternativa en la nube (sin Android Studio / Xcode)
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest build --profile development-simulator --platform ios

# Con el dev build ya instalado
npm start
```

Las carpetas `android/` e `ios/` se generan (Continuous Native Generation) y no se versionan;
la configuración nativa vive en `app.json`.

## Base de datos local

- Esquema: [`src/db/schema.ts`](src/db/schema.ts) — `categories`, `location_targets`, `tasks`,
  `geofence_triggers`, `notification_logs`, `pois` y `poi_areas` (caché de locales por rubro).
- Migraciones: [`drizzle/`](drizzle/) (generadas, no editar a mano). Se aplican al arrancar en
  el layout raíz [`src/app/_layout.tsx`](src/app/_layout.tsx) con `useMigrations`.
- Repositorios: [`src/db/repositories/`](src/db/repositories/), independientes del driver.
- Conexión: [`src/db/client.ts`](src/db/client.ts) habilita `foreign_keys` y WAL.

```
categories 1──* tasks 1──* geofence_triggers *──1 location_targets
                  │                │
                  └──* notification_logs *──┘   (FK set null: el historial sobrevive)
```

`geofence_triggers` une una tarea con un lugar para una transición (`enter` / `exit` / `dwell`)
y guarda el último estado conocido de la geocerca (`unknown` / `inside` / `outside`).

### Cambiar el esquema

```bash
# 1. Editar src/db/schema.ts
npm run db:generate -- --name <descripcion>   # 2. genera drizzle/NNNN_<descripcion>.sql
# 3. Reiniciar Metro (npm start): la versión de caché depende del contenido de los .sql
```

No agregar `CHECK` (ni otros cambios que obliguen a reconstruir la tabla) a tablas existentes:
SQLite no los admite con `ALTER TABLE`, Drizzle recrea la tabla y, como las migraciones corren en
una transacción, el `PRAGMA foreign_keys=OFF` no tiene efecto y el `DROP TABLE` dispara los
`ON DELETE CASCADE`. Revisar siempre el `.sql` generado antes de commitear.

## Permisos (onboarding)

Antes de la pantalla principal, `PermissionGate` ([`src/screens/PermissionsOnboardingScreen.tsx`](src/screens/PermissionsOnboardingScreen.tsx))
guía los permisos en este orden y relee el estado cada vez que la app vuelve a primer plano
(así detecta lo que el usuario cambió en Ajustes):

1. Ubicación en primer plano, tras una explicación de para qué se usa «todo el tiempo».
2. Ubicación precisa (sin ella no se disparan las geocercas).
3. Elevación a background (`ACCESS_BACKGROUND_LOCATION` / «Siempre»). Si se rechaza, se muestra
   un estado explicativo con enlace a Ajustes.
4. Notificaciones locales (`POST_NOTIFICATIONS` en Android 13+; antes se crea el canal `zone-alerts`).
5. Solo Android: optimización de batería y ahorro de energía activos, con enlace a cada ajuste y a
   la guía de [dontkillmyapp.com](https://dontkillmyapp.com) si el fabricante es conocido por cerrar apps.

Cada grupo se puede posponer hasta el próximo arranque. La lógica de pasos es pura y vive en
[`src/permissions/model.ts`](src/permissions/model.ts); el acceso a módulos nativos, en
[`src/permissions/service.ts`](src/permissions/service.ts).

## Calidad

```bash
npm run typecheck
npm run lint
```

## Tareas

La pantalla principal ([`src/screens/TasksScreen.tsx`](src/screens/TasksScreen.tsx)) es el alta
rápida (US-2.1): el campo recibe el foco al abrir la app y la tarea se guarda con Enter o «Agregar»
(un toque), queda en estado `pending` —que la interfaz muestra como «Activa»— y el teclado sigue
abierto para la siguiente. Debajo, la lista de tareas activas se actualiza sola con `useLiveQuery`.
La limpieza del título y las etiquetas de estado viven en [`src/tasks/model.ts`](src/tasks/model.ts).

Debajo del alta hay tres pestañas (US-2.2), con el contador de cada una:

- **Activas**: tareas `pending` agrupadas por anclaje — *Por lugar* (tiene un trigger de geocerca
  activo; gana si además tiene rubro), *Por rubro* (tiene categoría) y *Generales*.
- **Cercanas hoy**: tareas pendientes ancladas a un lugar donde el usuario está dentro de la
  geocerca (`lastState = 'inside'`) o que están a ≤ 1 km (o al radio de la geocerca, si es mayor)
  de la posición actual, y tareas por rubro con un local de su rubro a ≤ 1 km según el caché de
  POIs; de la más cercana a la más lejana. La posición se lee al abrir la app y al entrar en la
  pestaña (última conocida de ≤ 5 min o un fix de precisión media).
- **Completadas**: de la completada más recientemente a la más antigua.

Deslizar una fila a la derecha la completa (en *Completadas*, la reactiva) y a la izquierda la
archiva; una barra permite deshacer durante 5 s. Con lector de pantalla, las mismas acciones están
disponibles como acciones de accesibilidad. El gesto usa `PanResponder` + `Animated` de React
Native, sin módulos nativos extra. Las archivadas no se muestran en ninguna pestaña.
Filtros, agrupación y distancias son funciones puras en [`src/tasks/list.ts`](src/tasks/list.ts).

## Navegación

La app usa Expo Router (`main: expo-router/entry`). Las rutas viven en [`src/app/`](src/app/):

| Ruta | Archivo | Pantalla |
| --- | --- | --- |
| `/` | `src/app/index.tsx` | Lista de tareas |
| `/tasks/:id` | `src/app/tasks/[id]/index.tsx` | Detalle: lugar, rubro y horario |
| `/tasks/:id/place` | `src/app/tasks/[id]/place.tsx` | Lugar de la tarea |
| `/settings` | `src/app/settings.tsx` | Ajustes de avisos (enfriamiento) |

El layout raíz aplica las migraciones y muestra el onboarding de permisos antes del stack.

## Lugar específico de una tarea (US-3.1)

Tocar una tarea abre su detalle y, desde ahí, «Elegir lugar en el mapa» abre el selector
([`src/screens/PlacePickerScreen.tsx`](src/screens/PlacePickerScreen.tsx)):

- **Mapa**: MapLibre React Native con el estilo vectorial *Liberty* de
  [OpenFreeMap](https://openfreemap.org) (datos de OpenStreetMap, sin clave de API).
- **Búsqueda**: autocompletado de comercios, lugares y direcciones con
  [Photon](https://photon.komoot.io) (OpenStreetMap, sin clave), 350 ms después de la última tecla
  y priorizando resultados cerca del usuario. Mantener presionado el mapa elige ese punto: si hay un
  lugar conocido a ≤ 40 m se toma ese, si no queda el punto exacto («Punto en el mapa»).
- **Radio**: presets de 100, 200 y 500 m, o arrastrando el punto del borde del círculo
  (entre 100 m y 2 km, en pasos de 10 m).
- **Guardar** crea un `location_target` con nombre comercial, dirección legible, latitud, longitud
  y radio, y un `geofence_trigger` de entrada que lo une a la tarea, en una sola transacción
  ([`src/db/repositories/taskPlaces.ts`](src/db/repositories/taskPlaces.ts)). Cada tarea tiene un
  solo lugar: elegir otro reemplaza el anterior y «Quitar lugar» la desancla; los lugares que
  quedan sin uso se borran.

El parseo de Photon y los radios están en [`src/places/model.ts`](src/places/model.ts), la
geometría (distancias, círculo) en [`src/places/geo.ts`](src/places/geo.ts) y las llamadas de red
en [`src/places/service.ts`](src/places/service.ts).

## Geocercas en el sistema operativo (US-3.2)

Las geocercas nativas se registran con `expo-location` (`startGeofencingAsync`, que usa
`GeofencingClient` en Android y region monitoring en iOS) y `expo-task-manager`:

- **Registro** ([`src/geofencing/GeofenceSync.tsx`](src/geofencing/GeofenceSync.tsx) +
  [`service.ts`](src/geofencing/service.ts)): con la app abierta, cada cambio en tareas pendientes o
  triggers, y cada vuelta a primer plano, alinea las regiones del sistema con los triggers armados
  (activos y de tareas `pending`). Si no cambió nada no vuelve a registrar, porque cada registro
  hace que Android repita el estado actual de todas las regiones. Sin permiso de ubicación en
  segundo plano se detiene. Límite: 20 regiones en iOS y 100 en Android; si hay más, se priorizan
  las más cercanas. Los triggers `dwell` todavía no se registran.
- **Disparo** ([`src/geofencing/background.ts`](src/geofencing/background.ts)): la tarea
  `zonify-geofences` se define al cargar el bundle (importada primero en `src/app/_layout.tsx`),
  así que corre aunque la app esté en segundo plano o cerrada. Aplica migraciones pendientes y
  delega en [`handleEvent.ts`](src/geofencing/handleEvent.ts): guarda `lastState` /
  `lastTransitionAt` del trigger y, al **entrar** a la región de un trigger de entrada, muestra una
  notificación local (ver «Avisos») y la registra en `notification_logs`.
- **Sin avisos repetidos** ([`model.ts`](src/geofencing/model.ts)): no se avisa si el trigger ya
  estaba `inside` (el registro repite el estado actual), si la tarea no está pendiente o está
  pospuesta, ni dentro del enfriamiento del lugar (ver «Avisos»).

## Rubros (épica 4)

### Catálogo y selección (US-4.1)

El catálogo vive en código ([`src/categories/catalog.ts`](src/categories/catalog.ts)) con sus
etiquetas de OpenStreetMap, y al arrancar se guarda en `categories` por `slug`
([`seed.ts`](src/categories/seed.ts); si el usuario ya tenía una categoría con el mismo nombre,
se adopta):

| Rubro | Etiquetas OSM |
| --- | --- |
| Farmacia | `amenity=pharmacy` |
| Mascotas / Veterinaria | `shop=pet`, `amenity=veterinary` |
| Supermercado / Almacén | `shop=supermarket`, `shop=convenience` |
| Gimnasio | `leisure=fitness_centre` |
| Cine | `amenity=cinema` |

Al crear una tarea, una fila de chips ([`CategoryChips`](src/components/CategoryChips.tsx))
permite elegir un rubro opcional (selección única; tocar el elegido lo quita). Para lectores de
pantalla son un `radiogroup` con el nombre del rubro como etiqueta; el emoji es decorativo. Si una
tarea tiene lugar propio y rubro, gana el lugar.

### Caché de POIs (US-4.3)

[`src/pois/`](src/pois/) descarga de [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API)
los locales del catálogo en un círculo de 3 km alrededor de la última posición conocida (la de
la última hora, normalmente donde se carga el teléfono) y los guarda en `pois` / `poi_areas`:

- **Cuándo**: con Wi-Fi y cargando si la zona tiene más de 7 días; con Wi-Fi aunque no cargue si
  la zona no está descargada (sin ella los recordatorios por rubro no funcionan). Nunca con datos
  móviles. Se intenta al abrir la app, al volver a primer plano y en la tarea periódica
  `zonify-poi-sync` (`expo-background-task`: WorkManager en Android, BGTaskScheduler en iOS, cada
  ≥ 6 h según decida el sistema).
- **Consulta**: una cláusula por clave OSM con regex de valores sobre un bounding box (mucho más
  rápida que `around`), nodos, vías y relaciones con su centro. Se prueban varias instancias
  públicas en orden. Una respuesta cortada por tiempo (`remark` de error) se descarta para no
  borrar locales válidos.
- **Guardado**: en una transacción; los locales conservan su id al refrescar y los que ya no
  vuelven en la zona se borran. Lo descargado hace más de 60 días se elimina. Cambiar las
  etiquetas del catálogo invalida las zonas (`catalog_signature`).

### Rotación dinámica de geocercas (US-4.2)

`syncGeofences` planifica con [`planRegions`](src/geofencing/model.ts) y registra:

- **Locales por rubro**: si hay tareas pendientes ancladas solo a un rubro, hasta 15 locales del
  caché a ≤ 2 km, alternando rubros (el más cercano de cada uno, después el segundo…) para que un
  rubro denso no tape a otro. Radio de 100 m; avisan solo al entrar.
- **Centinela**: una geocerca de 500 m centrada en el usuario que avisa al salir. Al moverse
  > 500 m el sistema despierta la app (geofencing de bajo consumo: celdas y Wi-Fi), que vuelve a
  elegir los locales alrededor de la nueva posición y re-registra todo, también en segundo plano o
  con la app cerrada. Mientras el usuario esté a < 200 m del centro registrado se conserva, para
  no re-registrar por el ruido del GPS.
- **Límite**: nunca más de 18 regiones en iOS (20 del sistema con margen) y 100 en Android. Si no
  alcanza, se reservan al menos 5 lugares para locales y el resto para los lugares propios más
  cercanos.
- **Aviso**: al entrar al radio de un local se avisan juntas las tareas pendientes de sus rubros
  (ver «Avisos» más abajo).

## Avisos (épica 6)

### Notificación enriquecida (US-6.1)

El aviso muestra el lugar arriba y las tareas abajo (`alertContent` en
[`model.ts`](src/geofencing/model.ts)):

```
📍 Farmacia del Valle (a 90m)
Comprar aspirinas y gasas
```

La distancia sale de la última posición conocida (≤ 2 min) en el momento del evento; si no hay,
se omite. Varias tareas del rubro se unen («A, B y C»). Suena y vibra por el canal
`zone-alerts-v2` (importancia alta, sonido por defecto y vibración `[0, 250, 150, 250]`; el canal
original se creó sin vibración explícita y Android no deja cambiarla, así que se reemplazó).
Tocar el aviso abre el detalle de su primera tarea, también si la app estaba cerrada
([`NotificationResponses`](src/notifications/NotificationResponses.tsx)).

### Enfriamiento (US-6.2)

- **Por local o lugar**: después de avisar, el mismo local de rubro (por `osm_key`) o lugar propio
  no vuelve a avisar durante 12 h. Se configura en Ajustes (⚙️ en la lista): 6, 12 o 24 h
  (`app_settings`).
- **Por tarea de rubro**: una tarea no se repite en menos de 1 h aunque pase por otro local del
  rubro.
- **Posponer**: el botón «Posponer 2 h» silencia la tarea y todo su rubro durante 2 h
  (`tasks.snoozed_until` y `categories.snoozed_until`).

### Acciones desde el aviso (US-6.3)

Los avisos tienen los botones **Hecho** (completa las tareas del aviso, re-registra las geocercas
—así se cancelan las suyas— y lo quita de la bandeja) y **Posponer 2 h**. Ninguno abre la app: en
Android, con la app en segundo plano o cerrada, los procesa la tarea
`zonify-notification-actions` (`Notifications.registerTaskAsync`), que despierta solo el JS;
con la app abierta, `NotificationResponses`. Las acciones son idempotentes. La lógica está en
[`src/notifications/actions.ts`](src/notifications/actions.ts).

## Batería y robustez (épica 7)

### Detección adaptativa por velocidad (US-7.1)

En lugar de ActivityRecognition / CMMotionActivity (Expo no los trae y requerirían un módulo nativo
propio y un permiso más), el movimiento se estima con la velocidad de las posiciones que la app ya
lee al planificar las geocercas: la que informa el sistema o, si no la hay, distancia / tiempo
desde la posición de la planificación anterior (≤ 15 min). Como la centinela se dispara al
moverse 500 m, dos salidas seguidas dan una buena estimación.

| Modo | Velocidad | Geocerca de local | Centinela |
| --- | --- | --- | --- |
| Quieto | < 0,5 m/s | 100 m | 500 m |
| A pie | 0,5–7 m/s | 100 m | 500 m |
| En vehículo | ≥ 7 m/s (~25 km/h) | 250 m (tiempo de reacción) | 1,5 km (menos despertares) |

Desde ~80 km/h no se avisa por locales de rubro (falsos positivos en autopista). Quieto no cambia
nada porque no hay nada que apagar: la app no consulta el GPS ni corre en segundo plano; solo
quedan las geocercas del sistema, que son pasivas (celdas y Wi-Fi), y la descarga de POIs, que
solo corre con Wi-Fi. El criterio de < 1 % en 8 h quieto se mide en el teléfono (Ajustes →
Batería → uso por app).

### Reinicios y procesos cerrados (US-7.2)

- **Android**: `expo-task-manager` declara un receptor de `BOOT_COMPLETED` y
  `MY_PACKAGE_REPLACED`. Al arrancar el proceso, `TaskService.restoreTasks()` vuelve a registrar
  la tarea de geocercas y su consumidor llama de nuevo a `GeofencingClient.addGeofences` con las
  regiones guardadas; lo mismo pasa con la tarea de POIs (WorkManager persiste solo). Si el
  sistema mata el proceso, las geocercas siguen en Google Play Services y despiertan la app.
  Limitación de Android: después de «Forzar detención» desde Ajustes, la app no recibe nada hasta
  que el usuario la vuelve a abrir.
- **iOS**: CoreLocation conserva las regiones monitoreadas tras reinicios y cierres, y relanza la
  app en segundo plano al cruzarlas; `expo-task-manager` restaura las tareas en
  `didFinishLaunchingWithOptions`. (No probado: el desarrollo es en Linux.)

## Horario de avisos (US-5.2)

En el detalle de la tarea ([`TaskDetailScreen`](src/screens/TaskDetailScreen.tsx)) se elige,
opcionalmente, una franja «desde/hasta» (HH:MM; puede cruzar la medianoche, p. ej. 22:00–02:00) y
los días de la semana (con atajos «Lun a Vie» y «Todos los días»). Se guarda por tarea en
`tasks.alert_start_minute`, `alert_end_minute` y `alert_days` (máscara de bits, lunes = bit 0); la
lista muestra «🔔 08:30–20:30 · Lun a Vie».

Fuera de la ventana el aviso **llega igual pero sin sonido ni vibración**: en Android por el canal
`zone-alerts-silent` (importancia baja, sin sonido ni vibración; Android no deja cambiar el sonido
de un canal existente) y en iOS con `interruptionLevel: 'passive'`. Con la app abierta, los avisos
silenciosos van solo a la lista de notificaciones, sin banner. Un aviso que agrupa varias tareas
de un rubro suena si alguna está dentro de su ventana. `notification_logs.silent` registra cómo
salió cada aviso. La lógica está en [`src/tasks/schedule.ts`](src/tasks/schedule.ts); en una franja
que cruza la medianoche, la parte de después de las 00:00 cuenta como del día en que empezó.

Los rangos se validan en el repositorio (`setAlertWindow`) y no con `CHECK`: agregar un `CHECK` a
una tabla existente obliga a Drizzle a reconstruirla, y dentro de la transacción de migración el
`DROP TABLE` dispararía los `ON DELETE CASCADE`.

**Latencia**: el criterio de aceptación pide < 60 s. Android documenta una latencia típica de
~2 minutos para geocercas, mayor con el teléfono quieto o en Doze; `expo-location` usa la
responsiveness por defecto del sistema. Hay que medirlo en el dispositivo; si no alcanza, se puede
reforzar (p. ej. con actualizaciones de ubicación en segundo plano mientras haya tareas cerca).

MapLibre, `react-native-screens`, Expo Router, `expo-task-manager`, `expo-background-task` y
`expo-network` incluyen código nativo: después de actualizar hay que
recompilar el dev build (`npm run android` o EAS).

La pantalla de diagnóstico de la base ([`src/screens/DatabaseDiagnosticsScreen.tsx`](src/screens/DatabaseDiagnosticsScreen.tsx))
ya no se muestra.
