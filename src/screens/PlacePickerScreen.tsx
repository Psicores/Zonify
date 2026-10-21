import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapView,
  Marker,
  NativeUserLocation,
  ViewAnnotation,
  type CameraRef,
  type InitialViewState,
  type PressEvent,
  type ViewAnnotationEvent,
} from '@maplibre/maplibre-react-native';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { usePermissions } from '../permissions/PermissionsProvider';
import {
  bearingDegrees,
  circleBounds,
  circlePolygon,
  destinationPoint,
  distanceMeters,
  type Coordinates,
} from '../places/geo';
import {
  clampRadius,
  DEFAULT_RADIUS_METERS,
  MIN_QUERY_LENGTH,
  pinnedPoint,
  RADIUS_PRESETS,
  resolvePressedPoint,
  type PlaceCandidate,
} from '../places/model';
import { reverseGeocode } from '../places/service';
import { usePlaceSearch, type SearchStatus } from '../places/usePlaceSearch';
import { formatDistance } from '../tasks/list';
import { useCurrentPosition } from '../tasks/useCurrentPosition';

// Estilo vectorial de OpenFreeMap sobre datos de OpenStreetMap: gratuito y sin clave.
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ACCENT = '#0f766e';
const NEARBY_ZOOM = 15;
const WORLD_VIEW: InitialViewState = { center: [0, 20], zoom: 1 };

interface InitialData {
  taskTitle: string | null;
  place: PlaceCandidate | null;
  radius: number;
}

/**
 * Lleva la cámara a mostrar entero un círculo.
 *
 * @pre `camera` está montada o es `null`.
 * @post Si hay cámara, anima el encuadre del círculo dejando margen para el
 *       buscador (arriba) y la tarjeta (abajo); si no, no hace nada.
 */
function frameCircle(camera: CameraRef | null, center: Coordinates, radius: number) {
  camera?.fitBounds(circleBounds(center, radius), {
    padding: { top: 120, bottom: 280, left: 40, right: 40 },
    duration: 600,
  });
}

/**
 * Lee la coordenada de un evento del mapa.
 *
 * @pre `event.nativeEvent.lngLat` es `[longitud, latitud]`.
 * @post Devuelve la misma posición como `Coordinates`.
 */
function eventPoint(event: NativeSyntheticEvent<PressEvent | ViewAnnotationEvent>): Coordinates {
  const [longitude, latitude] = event.nativeEvent.lngLat;
  return { latitude, longitude };
}

/**
 * Selector de lugar específico para una tarea (US-3.1). Se busca un comercio o
 * dirección (autocompletado de Photon/OpenStreetMap) o se mantiene presionado el
 * mapa; el radio de la geocerca se elige con presets o arrastrando el punto del
 * borde del círculo.
 *
 * @pre La tarea `taskId` existe y la pantalla está dentro del stack de Expo
 *      Router y de `PermissionsProvider`.
 * @post Al abrirse pide la ubicación en primer plano si falta y no está
 *       pospuesta (US-3.1), y espera la respuesta antes de mostrar el mapa,
 *       para abrirlo donde está el usuario; sin ubicación ofrece activarla
 *       («Activar ubicación» ignora «Ahora no»). Al guardar, la tarea queda
 *       anclada a un `LocationTarget` nuevo con el nombre, la dirección, las
 *       coordenadas y el radio elegidos (reemplazando el lugar anterior), se
 *       abre el pedido de permisos de avisos y se vuelve a la pantalla previa.
 *       «Quitar lugar» desancla la tarea. Si una escritura falla, se muestra el
 *       error y no se sale de la pantalla. Al arrastrar el radio (US-3.2) se
 *       aplica como mucho un cambio por cuadro, y solo se redibujan el círculo,
 *       el punto de arrastre y la fila del radio: el buscador y el resto de la
 *       tarjeta son componentes memorizados que no dependen del radio.
 */
export function PlacePickerScreen({ taskId }: { taskId: number }) {
  const repos = useMemo(() => createRepositories(db), []);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const { position, status: positionStatus, refresh: refreshPosition } = useCurrentPosition();
  const { snapshot, prompting, askFor: askForPermissions } = usePermissions();
  const foregroundGranted = snapshot?.foreground === 'granted';

  const [initial, setInitial] = useState<InitialData | null>(null);
  const [selection, setSelection] = useState<PlaceCandidate | null>(null);
  const [radius, setRadius] = useState(DEFAULT_RADIUS_METERS);
  // Rumbo del punto de arrastre respecto del centro, para que siga al dedo.
  const [handleBearing, setHandleBearing] = useState(90);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Radio vigente para los callbacks que no deben cambiar con él (elegir un
  // resultado, guardar): si cambiaran, el buscador y la tarjeta memorizados se
  // redibujarían en cada cuadro del arrastre.
  const radiusRef = useRef(radius);
  useEffect(() => {
    radiusRef.current = radius;
  }, [radius]);
  // Última posición del arrastre y cuadro pendiente que la aplica (US-3.2).
  const pendingDrag = useRef<Coordinates | null>(null);
  const dragFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    },
    [],
  );

  const near = position ?? selection;
  const search = usePlaceSearch(query, near?.latitude ?? null, near?.longitude ?? null);
  // El polígono (64 vértices) solo se recalcula si cambian el centro o el radio.
  const radiusShape = useMemo(() => (selection ? circlePolygon(selection, radius) : null), [selection, radius]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([repos.tasks.getById(taskId), repos.taskPlaces.get(taskId)])
      .then(([task, place]) => {
        if (cancelled) return;
        const candidate = place
          ? {
              key: `target-${place.id}`,
              name: place.name,
              address: place.address,
              latitude: place.latitude,
              longitude: place.longitude,
            }
          : null;
        setInitial({
          taskTitle: task?.title ?? null,
          place: candidate,
          radius: place ? clampRadius(place.radiusMeters) : DEFAULT_RADIUS_METERS,
        });
        setSelection(candidate);
        if (place) setRadius(clampRadius(place.radiusMeters));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(`No se pudo leer la tarea: ${e instanceof Error ? e.message : String(e)}`);
        setInitial({ taskTitle: null, place: null, radius: DEFAULT_RADIUS_METERS });
      });
    return () => {
      cancelled = true;
    };
  }, [repos, taskId]);

  // Se vuelve a intentar cuando se leen los permisos (cambia `askForPermissions`);
  // si el usuario ya respondió o pospuso, no abre nada.
  useEffect(() => {
    askForPermissions('location');
  }, [askForPermissions]);

  // La posición se leyó antes de que el usuario diera el permiso.
  const positionStale = foregroundGranted && positionStatus === 'denied';
  useEffect(() => {
    if (positionStale) void refreshPosition();
  }, [positionStale, refreshPosition]);

  /**
   * Elige un lugar y lo encuadra.
   *
   * @pre Ninguna.
   * @post `selection = place`, el punto de arrastre vuelve al este, se cierra el
   *       teclado y la cámara muestra el círculo con el radio actual.
   */
  const choose = useCallback((place: PlaceCandidate) => {
    setSelection(place);
    setHandleBearing(90);
    setSearchFocused(false);
    setQuery('');
    Keyboard.dismiss();
    frameCircle(cameraRef.current, place, radiusRef.current);
  }, []);

  /**
   * Elige el punto mantenido presionado en el mapa.
   *
   * @pre Ninguna.
   * @post Elige enseguida el punto exacto y, cuando responde el buscador, lo
   *       reemplaza por el resultado de `resolvePressedPoint`, salvo que el
   *       usuario ya haya elegido otro lugar.
   */
  const onLongPress = useCallback(
    (event: NativeSyntheticEvent<PressEvent>) => {
      const point = eventPoint(event);
      const pinned = pinnedPoint(point);
      choose(pinned);
      reverseGeocode(point)
        .then((nearest) => {
          const resolved = resolvePressedPoint(point, nearest);
          setSelection((current) => (current?.key === pinned.key ? resolved : current));
        })
        .catch(() => {
          // Sin red el punto exacto sigue sirviendo; solo falta el nombre.
        });
    },
    [choose],
  );

  /**
   * Cambia el radio con un preset.
   *
   * @pre `preset` está en `RADIUS_PRESETS`.
   * @post `radius = preset` y, si hay lugar elegido, la cámara encuadra el círculo nuevo.
   */
  const choosePreset = useCallback(
    (preset: number) => {
      setRadius(preset);
      if (selection) frameCircle(cameraRef.current, selection, preset);
    },
    [selection],
  );

  /**
   * Ajusta el radio según dónde está el punto de arrastre.
   *
   * @pre Hay un lugar elegido.
   * @post `radius` es la distancia del centro a `point`, acotada con
   *       `clampRadius`, y el punto queda en el rumbo en que lo dejó el dedo.
   */
  const applyDrag = useCallback(
    (point: Coordinates) => {
      if (!selection) return;
      setRadius(clampRadius(distanceMeters(selection, point)));
      setHandleBearing(bearingDegrees(selection, point));
    },
    [selection],
  );

  /**
   * Recibe el arrastre del punto del borde (US-3.2).
   *
   * @pre Ninguna.
   * @post Guarda la última posición y, si no hay un cuadro pendiente, pide uno
   *       que la aplica con `applyDrag`: aunque el mapa informe el arrastre más
   *       seguido, el círculo cambia como mucho una vez por cuadro.
   */
  const onHandleDrag = (event: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    pendingDrag.current = eventPoint(event);
    if (dragFrame.current !== null) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null;
      if (pendingDrag.current) applyDrag(pendingDrag.current);
    });
  };

  /**
   * Termina el arrastre del punto del borde.
   *
   * @pre Ninguna.
   * @post Descarta el cuadro pendiente y aplica enseguida la posición final,
   *       para que el radio guardado sea exactamente donde se soltó el dedo.
   */
  const onHandleDragEnd = (event: NativeSyntheticEvent<ViewAnnotationEvent>) => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    pendingDrag.current = null;
    applyDrag(eventPoint(event));
  };

  /**
   * Guarda el lugar elegido como ancla de la tarea.
   *
   * @pre Hay un lugar elegido.
   * @post Si se guarda, abre el pedido de permisos de avisos y vuelve a la
   *       pantalla anterior; si falla, `error` tiene el mensaje.
   */
  const save = useCallback(() => {
    if (!selection) return;
    try {
      repos.taskPlaces.setPlace(taskId, {
        name: selection.name,
        address: selection.address,
        latitude: selection.latitude,
        longitude: selection.longitude,
        radiusMeters: radiusRef.current,
      });
      askForPermissions('alerts');
      router.back();
    } catch (e) {
      setError(`No se pudo guardar el lugar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selection, repos, taskId, askForPermissions, router]);

  /**
   * Desancla la tarea de su lugar.
   *
   * @pre Ninguna.
   * @post Si funciona, vuelve a la pantalla anterior; si falla, `error` tiene el mensaje.
   */
  const removePlace = useCallback(() => {
    try {
      repos.taskPlaces.clearPlace(taskId);
      router.back();
    } catch (e) {
      setError(`No se pudo quitar el lugar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [repos, taskId, router]);

  const focusSearch = useCallback(() => setSearchFocused(true), []);
  const activateLocation = useCallback(
    () => askForPermissions('location', { force: true }),
    [askForPermissions],
  );

  // El mapa se monta cuando se sabe dónde abrirlo: el lugar guardado, la
  // posición del usuario (cuando respondió el pedido de ubicación) o, si no hay
  // ninguno, el mundo entero.
  if (!initial || (!initial.place && (positionStatus === 'loading' || !snapshot || prompting || positionStale))) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const initialView: InitialViewState = initial.place
    ? { bounds: circleBounds(initial.place, initial.radius), padding: { top: 120, bottom: 280, left: 40, right: 40 } }
    : position
      ? { center: [position.longitude, position.latitude], zoom: NEARBY_ZOOM }
      : WORLD_VIEW;
  const handle = selection ? destinationPoint(selection, radius, handleBearing) : null;
  const showResults = searchFocused && query.trim().length >= MIN_QUERY_LENGTH;
  const distanceToSelection = selection && position ? distanceMeters(position, selection) : null;

  return (
    <View style={styles.container}>
      <MapView style={StyleSheet.absoluteFill} mapStyle={MAP_STYLE_URL} onLongPress={onLongPress} logo={false}>
        <Camera ref={cameraRef} initialViewState={initialView} />
        {positionStatus === 'ready' && <NativeUserLocation />}
        {selection && handle && radiusShape && (
          <>
            <GeoJSONSource id="radius" data={radiusShape}>
              <Layer type="fill" id="radius-fill" paint={{ 'fill-color': ACCENT, 'fill-opacity': 0.15 }} />
              <Layer type="line" id="radius-line" paint={{ 'line-color': ACCENT, 'line-width': 2 }} />
            </GeoJSONSource>
            <Marker lngLat={[selection.longitude, selection.latitude]} anchor="bottom">
              <View style={styles.pin} accessibilityLabel={`Lugar elegido: ${selection.name}`} />
            </Marker>
            <ViewAnnotation
              id="radius-handle"
              lngLat={[handle.longitude, handle.latitude]}
              draggable
              onDrag={onHandleDrag}
              onDragEnd={onHandleDragEnd}
            >
              <View style={styles.handle} accessibilityLabel="Arrastra para cambiar el radio" />
            </ViewAnnotation>
          </>
        )}
      </MapView>

      <SearchPanel
        taskTitle={initial.taskTitle}
        query={query}
        onQueryChange={setQuery}
        onFocus={focusSearch}
        showResults={showResults}
        status={search.status}
        results={search.results}
        position={position}
        onChoose={choose}
      />

      <View style={[styles.card, { paddingBottom: 16 + insets.bottom }]}>
        <PlaceSummary selection={selection} distance={distanceToSelection} />
        <RadiusControl radius={radius} hasSelection={selection !== null} onPreset={choosePreset} />
        <CardActions
          showLocationLink={positionStatus === 'denied' && !foregroundGranted}
          onActivateLocation={activateLocation}
          error={error}
          canRemove={initial.place !== null}
          onRemove={removePlace}
          canSave={selection !== null}
          onSave={save}
        />
      </View>
    </View>
  );
}

interface SearchPanelProps {
  taskTitle: string | null;
  query: string;
  onQueryChange: (text: string) => void;
  onFocus: () => void;
  showResults: boolean;
  status: SearchStatus;
  results: readonly PlaceCandidate[];
  position: Coordinates | null;
  onChoose: (place: PlaceCandidate) => void;
}

/**
 * Buscador de comercios y direcciones, arriba del mapa. Memorizado: no depende
 * del radio, así que no se redibuja al arrastrarlo (US-3.2).
 *
 * @pre `results` conserva su identidad mientras no cambie.
 * @post Muestra el título de la tarea, el campo y, con `showResults`, el estado
 *       de la búsqueda y los resultados con su distancia a `position`; tocar uno
 *       llama a `onChoose`.
 */
const SearchPanel = memo(function SearchPanel({
  taskTitle,
  query,
  onQueryChange,
  onFocus,
  showResults,
  status,
  results,
  position,
  onChoose,
}: SearchPanelProps) {
  return (
    <View style={styles.searchBox}>
      {taskTitle && (
        <Text style={styles.taskTitle} numberOfLines={1}>
          {taskTitle}
        </Text>
      )}
      <TextInput
        style={styles.searchInput}
        value={query}
        onChangeText={onQueryChange}
        onFocus={onFocus}
        placeholder="Busca un comercio o dirección"
        placeholderTextColor="#94a3b8"
        autoCorrect={false}
        enterKeyHint="search"
        accessibilityLabel="Buscar lugar"
      />
      {showResults && (
        <View style={styles.results}>
          {status === 'loading' && <Text style={styles.resultsInfo}>Buscando…</Text>}
          {status === 'error' && <Text style={styles.resultsInfo}>No se pudo buscar. Revisa tu conexión.</Text>}
          {status === 'done' && results.length === 0 && (
            <Text style={styles.resultsInfo}>Sin resultados para «{query.trim()}».</Text>
          )}
          <FlatList
            data={results}
            keyExtractor={(place) => place.key}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.result, pressed && styles.resultPressed]}
                onPress={() => onChoose(item)}
                accessibilityRole="button"
              >
                <Text style={styles.resultName}>{item.name}</Text>
                {item.address && <Text style={styles.resultAddress}>{item.address}</Text>}
                {position && (
                  <Text style={styles.resultAddress}>{formatDistance(distanceMeters(position, item))}</Text>
                )}
              </Pressable>
            )}
          />
        </View>
      )}
    </View>
  );
});

/**
 * Nombre, dirección y distancia del lugar elegido. Memorizado: no depende del radio.
 *
 * @pre Ninguna.
 * @post Sin lugar elegido, explica cómo elegir uno.
 */
const PlaceSummary = memo(function PlaceSummary({
  selection,
  distance,
}: {
  selection: PlaceCandidate | null;
  distance: number | null;
}) {
  if (!selection) {
    return (
      <Text style={styles.placeAddress}>
        Busca un comercio o dirección, o mantén presionado el mapa para elegir un punto.
      </Text>
    );
  }
  return (
    <View>
      <Text style={styles.placeName}>{selection.name}</Text>
      {selection.address && <Text style={styles.placeAddress}>{selection.address}</Text>}
      {distance !== null && <Text style={styles.placeAddress}>{formatDistance(distance)} de ti</Text>}
    </View>
  );
});

/**
 * Radio actual y presets: lo único de la tarjeta que cambia al arrastrar.
 *
 * @pre `onPreset` recibe valores de `RADIUS_PRESETS`.
 * @post Muestra el radio, marca el preset igual a él y, con lugar elegido,
 *       explica cómo arrastrar el borde.
 */
const RadiusControl = memo(function RadiusControl({
  radius,
  hasSelection,
  onPreset,
}: {
  radius: number;
  hasSelection: boolean;
  onPreset: (preset: number) => void;
}) {
  return (
    <>
      <View style={styles.radiusRow}>
        <Text style={styles.radiusLabel}>Radio: {radius} m</Text>
        <View style={styles.presets}>
          {RADIUS_PRESETS.map((preset) => {
            const selected = preset === radius;
            return (
              <Pressable
                key={preset}
                style={[styles.preset, selected && styles.presetSelected]}
                onPress={() => onPreset(preset)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Radio de ${preset} metros`}
              >
                <Text style={[styles.presetText, selected && styles.presetTextSelected]}>{preset} m</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {hasSelection && <Text style={styles.hint}>Arrastra el punto del borde del círculo para ajustar el radio.</Text>}
    </>
  );
});

interface CardActionsProps {
  showLocationLink: boolean;
  onActivateLocation: () => void;
  error: string | null;
  canRemove: boolean;
  onRemove: () => void;
  canSave: boolean;
  onSave: () => void;
}

/**
 * Enlace de ubicación, error y botones de la tarjeta. Memorizado: no depende del radio.
 *
 * @pre Ninguna.
 * @post «Quitar lugar» solo aparece con `canRemove`; «Guardar lugar» está
 *       deshabilitado sin `canSave`.
 */
const CardActions = memo(function CardActions({
  showLocationLink,
  onActivateLocation,
  error,
  canRemove,
  onRemove,
  canSave,
  onSave,
}: CardActionsProps) {
  return (
    <>
      {showLocationLink && (
        <Pressable onPress={onActivateLocation} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.link}>Activar ubicación para ver dónde estás</Text>
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {canRemove && (
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={onRemove}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Quitar lugar</Text>
          </Pressable>
        )}
        <Pressable
          style={({ pressed }) => [styles.primary, !canSave && styles.disabled, pressed && styles.pressed]}
          onPress={onSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
        >
          <Text style={styles.primaryText}>Guardar lugar</Text>
        </Pressable>
      </View>
    </>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchBox: { position: 'absolute', top: 12, left: 12, right: 12, gap: 6 },
  taskTitle: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: '#334155',
    fontWeight: '600',
    overflow: 'hidden',
    maxWidth: '100%',
  },
  searchInput: {
    minHeight: 48,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    fontSize: 16,
  },
  results: { backgroundColor: '#fff', borderRadius: 10, maxHeight: 320, overflow: 'hidden' },
  resultsInfo: { color: '#64748b', padding: 14 },
  result: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  resultPressed: { backgroundColor: '#f1f5f9' },
  resultName: { fontSize: 16, color: '#0f172a' },
  resultAddress: { fontSize: 13, color: '#64748b' },
  pin: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: ACCENT,
    borderWidth: 3,
    borderColor: '#fff',
  },
  handle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: ACCENT,
  },
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 12,
  },
  placeName: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  placeAddress: { fontSize: 14, color: '#64748b' },
  radiusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  radiusLabel: { fontWeight: '600', color: '#334155' },
  presets: { flexDirection: 'row', gap: 6 },
  preset: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  presetSelected: { backgroundColor: ACCENT, borderColor: ACCENT },
  presetText: { color: '#334155', fontWeight: '600' },
  presetTextSelected: { color: '#fff' },
  hint: { color: '#94a3b8', fontSize: 12 },
  link: { color: ACCENT, fontWeight: '600' },
  error: { color: '#b91c1c' },
  actions: { flexDirection: 'row', gap: 8 },
  primary: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ACCENT,
    borderRadius: 10,
  },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  secondaryText: { color: '#b91c1c', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
