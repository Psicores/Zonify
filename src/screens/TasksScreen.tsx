import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryChips } from '../components/CategoryChips';
import { SwipeableRow, type SwipeAction } from '../components/SwipeableRow';
import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { usePermissions } from '../permissions/PermissionsProvider';
import { circleBounds, type Coordinates } from '../places/geo';
import type { Task } from '../db/schema';
import {
  buildSections,
  buildTaskListItems,
  formatDistance,
  nearestPlaceDistance,
  nearestPoiByCategory,
  NEARBY_DISTANCE_METERS,
  selectTab,
  SWIPE_ACTIONS,
  TASK_ACTION_DONE_MESSAGES,
  TASK_ACTION_LABELS,
  TASK_TABS,
  type TaskAction,
  type NearestPoi,
  type TaskListItem,
  type TaskTab,
} from '../tasks/list';
import { normalizeTaskTitle, TASK_STATUS_LABELS, TASK_TITLE_MAX_LENGTH } from '../tasks/model';
import { describeSchedule, scheduleOf } from '../tasks/schedule';
import { useCurrentPosition, type PositionStatus } from '../tasks/useCurrentPosition';

const ACTION_COLORS: Record<TaskAction, string> = {
  complete: '#15803d',
  archive: '#64748b',
  reopen: '#0f766e',
};

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  message: string;
  revert: () => Promise<unknown>;
}

/**
 * Pantalla principal: alta rápida de tareas (US-2.1), con rubro opcional
 * (US-4.1), y listado filtrado (US-2.2). El campo recibe el foco al abrirse,
 * así que guardar una tarea es escribirla y tocar Enter o «Agregar». Debajo,
 * tres pestañas: «Activas» agrupadas por anclaje (lugar, rubro, generales),
 * «Cercanas hoy» y «Completadas». Deslizar una fila la completa (o reactiva)
 * o la archiva.
 *
 * @pre Se renderiza dentro de `SafeAreaProvider` y con las migraciones aplicadas.
 * @post Cada alta válida crea una tarea en estado `pending`, vacía el campo y
 *       muestra la pestaña «Activas». Cada deslizamiento cambia el estado de la
 *       tarea y ofrece deshacerlo durante `UNDO_TIMEOUT_MS`. Si una escritura
 *       falla, se muestra el error y no se pierde lo escrito ni la fila.
 */
export function TasksScreen() {
  const repos = useMemo(() => createRepositories(db), []);
  const tasksQuery = useMemo(() => repos.tasks.list({ statuses: ['pending', 'completed'] }), [repos]);
  const placesQuery = useMemo(() => repos.geofenceTriggers.listActiveWithLocation(), [repos]);
  const categoriesQuery = useMemo(() => repos.categories.list(), [repos]);
  // Solo para enterarse de que se descargó una zona del caché de POIs.
  const poiAreasQuery = useMemo(() => repos.pois.listAreas(), [repos]);
  const { data: tasks } = useLiveQuery(tasksQuery);
  const { data: places } = useLiveQuery(placesQuery);
  const { data: categories } = useLiveQuery(categoriesQuery);
  const { data: poiAreas } = useLiveQuery(poiAreasQuery);
  const { position, status: positionStatus, refresh: refreshPosition } = useCurrentPosition();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { askFor: askForPermissions } = usePermissions();

  const [tab, setTab] = useState<TaskTab>('active');
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  // Evita dos altas de la misma tarea si se toca Enter y el botón seguidos.
  const saving = useRef(false);
  const title = normalizeTaskTitle(text);

  const items = useMemo(() => buildTaskListItems(tasks, places, categories), [tasks, places, categories]);
  // Rubros con tareas pendientes, como texto estable para no repetir la consulta en cada render.
  const pendingCategoryKey = [
    ...new Set(
      items
        .filter((item) => item.anchor === 'category' && item.task.status === 'pending')
        .map((item) => item.category!.id),
    ),
  ]
    .sort((a, b) => a - b)
    .join(',');
  const [nearestPois, setNearestPois] = useState<ReadonlyMap<number, NearestPoi>>(new Map());

  useEffect(() => {
    const ids = pendingCategoryKey ? pendingCategoryKey.split(',').map(Number) : [];
    if (!position || ids.length === 0) return;
    let cancelled = false;
    repos.pois
      .listInBounds(circleBounds(position, NEARBY_DISTANCE_METERS), ids)
      .then((pois) => {
        if (!cancelled) setNearestPois(nearestPoiByCategory(pois, position));
      })
      .catch(() => {
        // Sin caché la pestaña muestra solo las tareas con lugar propio.
      });
    return () => {
      cancelled = true;
    };
  }, [repos, position, pendingCategoryKey, poiAreas]);

  const tabItems = useMemo(
    () =>
      Object.fromEntries(
        TASK_TABS.map(({ key }) => [key, selectTab(items, key, position, nearestPois)]),
      ) as Record<TaskTab, TaskListItem[]>,
    [items, position, nearestPois],
  );
  const sections = useMemo(() => buildSections(tabItems[tab], tab), [tabItems, tab]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  /**
   * Guarda el texto actual como tarea nueva.
   *
   * @pre Ninguna.
   * @post Si hay título y no había otro guardado en curso, la tarea queda creada
   *       con el rubro elegido (si hay), `text` vacío, el rubro sin elegir,
   *       `error` en `null` y la pestaña en «Activas»; si falla, `error` tiene el
   *       mensaje y ni `text` ni el rubro cambian. Sin título no hace nada. Una
   *       tarea con rubro abre el pedido de permisos de avisos (US-3.1).
   */
  const save = useCallback(async () => {
    if (!title || saving.current) return;
    saving.current = true;
    try {
      await repos.tasks.create({ title, categoryId });
      if (categoryId !== null) askForPermissions('alerts');
      setText('');
      setCategoryId(null);
      setError(null);
      setTab('active');
    } catch (e) {
      setError(`No se pudo guardar la tarea: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      saving.current = false;
    }
  }, [repos, title, categoryId, askForPermissions]);

  /**
   * Aplica una acción de deslizamiento a una tarea.
   *
   * @pre `task` es la versión mostrada en la lista.
   * @post Si la escritura funciona, la tarea queda completada, archivada o
   *       pendiente según `action`, se anuncia a los lectores de pantalla y se
   *       ofrece deshacer (restaura `status` y `completedAt` previos).
   * @throws El error de la base si la escritura falla; antes deja el mensaje en `error`.
   */
  const applyAction = useCallback(
    async (task: Task, action: TaskAction) => {
      const previous = { status: task.status, completedAt: task.completedAt };
      try {
        if (action === 'complete') await repos.tasks.complete(task.id);
        else if (action === 'archive') await repos.tasks.archive(task.id);
        else await repos.tasks.reopen(task.id);
      } catch (e) {
        setError(`No se pudo actualizar la tarea: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      setError(null);
      const message = TASK_ACTION_DONE_MESSAGES[action];
      AccessibilityInfo.announceForAccessibility(message);
      setUndo({ message, revert: () => repos.tasks.update(task.id, previous) });
    },
    [repos],
  );

  /**
   * Deshace la última acción de deslizamiento.
   *
   * @pre Ninguna.
   * @post Si había algo para deshacer, la tarea vuelve a su estado anterior y la
   *       barra se oculta; si la escritura falla, `error` tiene el mensaje.
   */
  const revertLast = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    try {
      await undo.revert();
    } catch (e) {
      setError(`No se pudo deshacer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [undo]);

  /**
   * Cambia de pestaña.
   *
   * @pre Ninguna.
   * @post `tab = next`; al entrar en «Cercanas hoy» se vuelve a leer la posición.
   */
  const selectTabKey = (next: TaskTab) => {
    setTab(next);
    if (next === 'nearby') void refreshPosition();
  };

  const swipe = SWIPE_ACTIONS[tab];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Tareas</Text>
          <Pressable
            style={({ pressed }) => [styles.settingsButton, pressed && styles.buttonPressed]}
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Ajustes de avisos"
            hitSlop={8}
          >
            <Text style={styles.settingsIcon}>⚙️</Text>
          </Pressable>
        </View>
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            onSubmitEditing={save}
            placeholder="¿Qué tienes que hacer?"
            placeholderTextColor="#94a3b8"
            maxLength={TASK_TITLE_MAX_LENGTH}
            autoFocus
            autoCapitalize="sentences"
            enterKeyHint="done"
            submitBehavior="submit"
            accessibilityLabel="Nueva tarea"
          />
          <Pressable
            style={({ pressed }) => [
              styles.button,
              !title && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
            onPress={save}
            disabled={!title}
            accessibilityRole="button"
            accessibilityState={{ disabled: !title }}
          >
            <Text style={styles.buttonText}>Agregar</Text>
          </Pressable>
        </View>
        <CategoryChips categories={categories} selectedId={categoryId} onChange={setCategoryId} />
        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.tabs} accessibilityRole="tablist">
          {TASK_TABS.map(({ key, label }) => {
            const selected = key === tab;
            return (
              <Pressable
                key={key}
                style={[styles.tab, selected && styles.tabSelected]}
                onPress={() => selectTabKey(key)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={`${label}, ${tabItems[key].length}`}
              >
                <Text style={[styles.tabText, selected && styles.tabTextSelected]} numberOfLines={1}>
                  {label} <Text style={styles.tabCount}>{tabItems[key].length}</Text>
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.task.id)}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {section.title}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <SwipeableRow
            right={toSwipeAction(swipe.right, () => applyAction(item.task, swipe.right))}
            left={toSwipeAction(swipe.left, () => applyAction(item.task, swipe.left))}
            onSwipeStart={() => setScrollEnabled(false)}
            onSwipeEnd={() => setScrollEnabled(true)}
            onPress={() => router.push(`/tasks/${item.task.id}`)}
            pressHint="Abre la tarea para elegir dónde y cuándo avisa"
          >
            <TaskRow
              item={item}
              position={tab === 'nearby' ? position : null}
              nearestPois={tab === 'nearby' ? nearestPois : null}
            />
          </SwipeableRow>
        )}
        scrollEnabled={scrollEnabled}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.list, { paddingBottom: 96 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.empty}>{emptyMessage(tab, positionStatus)}</Text>}
        ListFooterComponent={
          sections.length > 0 ? (
            <Text style={styles.hint}>
              Toca una tarea para elegir dónde y cuándo avisa. Desliza a la derecha para{' '}
              {TASK_ACTION_LABELS[swipe.right].toLowerCase()} o a la izquierda para{' '}
              {TASK_ACTION_LABELS[swipe.left].toLowerCase()}.
            </Text>
          ) : undefined
        }
      />

      {undo && (
        <View style={[styles.snackbar, { bottom: 16 + insets.bottom }]} accessibilityLiveRegion="polite">
          <Text style={styles.snackbarText}>{undo.message}</Text>
          <Pressable onPress={revertLast} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.snackbarAction}>Deshacer</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

/**
 * Configura el lado de la fila que dispara una acción.
 *
 * @pre Ninguna.
 * @post Devuelve la acción con su etiqueta y color, que llama a `run` al dispararse.
 */
function toSwipeAction(action: TaskAction, run: () => Promise<void>): SwipeAction {
  return { label: TASK_ACTION_LABELS[action], color: ACTION_COLORS[action], onTrigger: run };
}

/**
 * Texto de una pestaña vacía.
 *
 * @pre Ninguna.
 * @post En «Cercanas hoy» explica si falta el permiso o la posición; en las demás,
 *       que todavía no hay tareas de ese tipo.
 */
function emptyMessage(tab: TaskTab, positionStatus: PositionStatus): string {
  if (tab === 'active') return 'Todavía no tienes tareas activas.';
  if (tab === 'completed') return 'Todavía no has completado tareas.';
  switch (positionStatus) {
    case 'loading':
      return 'Buscando tu ubicación…';
    case 'denied':
      return 'Permite el acceso a tu ubicación para ver las tareas cercanas.';
    case 'unavailable':
      return 'No pudimos obtener tu ubicación. Vuelve a abrir esta pestaña para reintentar.';
    case 'ready':
      return 'No hay tareas con lugar cerca de ti ahora.';
  }
}

/**
 * Detalle del anclaje que se muestra bajo el título.
 *
 * @pre Ninguna.
 * @post Con lugares: sus nombres y, si hay `position`, la distancia al más cercano.
 *       Con rubro: ícono y nombre del rubro y, si `nearestPois` tiene su local
 *       más cercano, el nombre de ese local y la distancia. Generales: `null`.
 */
function anchorDetail(
  item: TaskListItem,
  position: Coordinates | null,
  nearestPois: ReadonlyMap<number, NearestPoi> | null,
): string | null {
  if (item.anchor === 'category') {
    if (!item.category) return null;
    const label = [item.category.icon, item.category.name].filter(Boolean).join(' ');
    const nearest = nearestPois?.get(item.category.id);
    return nearest ? `${label} · ${nearest.name ?? 'Local'} ${formatDistance(nearest.distance)}` : label;
  }
  if (item.anchor === 'general') return null;
  const names = item.places.map((place) => place.name).join(', ');
  const distance = nearestPlaceDistance(item, position);
  return distance === null ? names : `${names} · ${formatDistance(distance)}`;
}

/**
 * Fila de la lista con el título, el anclaje y el estado de una tarea.
 *
 * @pre `item.task.status` es un valor de `TASK_STATUSES`.
 * @post Muestra el título completo, el detalle de `anchorDetail` y la ventana
 *       de avisos si los hay, y la etiqueta del estado (p. ej. «Activa»).
 */
function TaskRow({
  item,
  position,
  nearestPois,
}: {
  item: TaskListItem;
  position: Coordinates | null;
  nearestPois: ReadonlyMap<number, NearestPoi> | null;
}) {
  const detail = anchorDetail(item, position, nearestPois);
  const schedule = describeSchedule(scheduleOf(item.task));
  const completed = item.task.status === 'completed';
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, completed && styles.rowTitleCompleted]}>{item.task.title}</Text>
        {detail && <Text style={styles.rowDetail}>{detail}</Text>}
        {schedule && (
          <Text style={styles.rowDetail} accessibilityLabel={`Suena: ${schedule}`}>
            🔔 {schedule}
          </Text>
        )}
      </View>
      <Text style={[styles.badge, completed && styles.badgeCompleted]}>
        {TASK_STATUS_LABELS[item.task.status]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { padding: 16, paddingBottom: 8, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '700' },
  settingsButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 22 },
  composer: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    minHeight: 48,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingHorizontal: 16,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#b91c1c' },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderRadius: 10,
    padding: 3,
  },
  tab: {
    flex: 1,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 4,
  },
  tabSelected: { backgroundColor: '#fff' },
  tabText: { color: '#475569', fontWeight: '600', fontSize: 13 },
  tabTextSelected: { color: '#0f172a' },
  tabCount: { color: '#64748b', fontWeight: '400' },
  list: { paddingHorizontal: 16, gap: 8 },
  sectionTitle: {
    marginTop: 8,
    color: '#475569',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 24 },
  hint: { color: '#94a3b8', textAlign: 'center', fontSize: 12, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16 },
  rowTitleCompleted: { color: '#64748b', textDecorationLine: 'line-through' },
  rowDetail: { color: '#64748b', fontSize: 13 },
  badge: {
    color: '#0f766e',
    backgroundColor: '#ccfbf1',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
  },
  badgeCompleted: { color: '#475569', backgroundColor: '#e2e8f0' },
  snackbar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  snackbarText: { color: '#fff', flex: 1 },
  snackbarAction: { color: '#5eead4', fontWeight: '700' },
});
