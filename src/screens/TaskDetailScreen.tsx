import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryChips } from '../components/CategoryChips';
import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import type { Category, LocationTarget, Task } from '../db/schema';
import {
  ALL_DAYS_MASK,
  DEFAULT_END_MINUTE,
  DEFAULT_START_MINUTE,
  formatTime,
  parseTime,
  WEEK_DAYS,
  WEEKDAYS_MASK,
} from '../tasks/schedule';

const ACCENT = '#0f766e';

/**
 * Detalle de una tarea: dónde avisa (lugar o rubro) y en qué horario suena
 * el aviso (US-5.2).
 *
 * @pre La pantalla está dentro del stack de Expo Router y las migraciones aplicadas.
 * @post Mientras carga muestra un indicador; si la tarea no existe, un mensaje.
 *       Si no, muestra el formulario de `TaskDetailForm`, que se actualiza solo
 *       cuando cambia el lugar de la tarea (p. ej. al volver del mapa).
 */
export function TaskDetailScreen({ taskId }: { taskId: number }) {
  const repos = useMemo(() => createRepositories(db), []);
  const taskQuery = useMemo(() => repos.tasks.getById(taskId), [repos, taskId]);
  const placesQuery = useMemo(() => repos.geofenceTriggers.listByTask(taskId), [repos, taskId]);
  const categoriesQuery = useMemo(() => repos.categories.list(), [repos]);
  const { data: task, updatedAt } = useLiveQuery(taskQuery);
  const { data: triggers } = useLiveQuery(placesQuery);
  const { data: categories } = useLiveQuery(categoriesQuery);

  if (!updatedAt) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!task) {
    return (
      <View style={styles.center}>
        <Text>La tarea no existe.</Text>
      </View>
    );
  }

  const place = triggers.find((t) => t.isActive)?.locationTarget ?? null;
  // La `key` reinicia el formulario solo si cambia de tarea, no al guardar.
  return <TaskDetailForm key={task.id} task={task} place={place} categories={categories} />;
}

interface TaskDetailFormProps {
  task: Task;
  place: LocationTarget | null;
  categories: Category[];
}

/**
 * Formulario del detalle. Los cambios se guardan con «Guardar».
 *
 * @pre `task` existe.
 * @post Arranca con el rubro y la ventana de avisos guardados. «Guardar» valida
 *       las horas (HH:MM) y que haya al menos un día; si es válido guarda rubro
 *       y ventana y vuelve atrás, y si no muestra el error sin guardar nada.
 *       «Elegir lugar» abre el mapa de la tarea.
 */
function TaskDetailForm({ task, place, categories }: TaskDetailFormProps) {
  const repos = useMemo(() => createRepositories(db), []);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [categoryId, setCategoryId] = useState(task.categoryId);
  const [hoursEnabled, setHoursEnabled] = useState(task.alertStartMinute !== null);
  const [startText, setStartText] = useState(formatTime(task.alertStartMinute ?? DEFAULT_START_MINUTE));
  const [endText, setEndText] = useState(formatTime(task.alertEndMinute ?? DEFAULT_END_MINUTE));
  const [days, setDays] = useState(task.alertDays ?? ALL_DAYS_MASK);
  const [error, setError] = useState<string | null>(null);

  /**
   * Normaliza el texto de una hora al salir del campo.
   *
   * @pre Ninguna.
   * @post Si el texto es una hora válida lo reescribe como «HH:MM»; si no, lo deja.
   */
  const normalize = (text: string, set: (value: string) => void) => {
    const minute = parseTime(text);
    if (minute !== null) set(formatTime(minute));
  };

  /**
   * Prende o apaga un día.
   *
   * @pre `bit` está en [0, 6].
   * @post `days` cambia solo en ese bit.
   */
  const toggleDay = (bit: number) => setDays((mask) => mask ^ (1 << bit));

  /**
   * Valida y guarda el formulario.
   *
   * @pre Ninguna.
   * @post Si las horas son válidas (o la franja está apagada) y hay al menos un
   *       día, guarda el rubro y la ventana (días `null` si son todos) y vuelve
   *       atrás; si no, `error` explica qué corregir y no guarda nada.
   */
  const save = async () => {
    const start = hoursEnabled ? parseTime(startText) : null;
    const end = hoursEnabled ? parseTime(endText) : null;
    if (hoursEnabled && (start === null || end === null)) {
      setError('Revisa las horas: usa el formato HH:MM, por ejemplo 08:30.');
      return;
    }
    if (hoursEnabled && start === end) {
      setError('La hora de inicio y la de fin no pueden ser iguales.');
      return;
    }
    if (days === 0) {
      setError('Elige al menos un día.');
      return;
    }
    try {
      await repos.tasks.update(task.id, { categoryId });
      await repos.tasks.setAlertWindow(task.id, {
        alertStartMinute: start,
        alertEndMinute: end,
        alertDays: days === ALL_DAYS_MASK ? null : days,
      });
      router.back();
    } catch (e) {
      setError(`No se pudo guardar: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const crossesMidnight = (() => {
    const start = parseTime(startText);
    const end = parseTime(endText);
    return hoursEnabled && start !== null && end !== null && start > end;
  })();

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{task.title}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Dónde avisar
          </Text>
          {place ? (
            <View style={styles.place}>
              <Text style={styles.placeName}>📍 {place.name}</Text>
              {place.address && <Text style={styles.muted}>{place.address}</Text>}
              <Text style={styles.muted}>Radio: {Math.round(place.radiusMeters)} m</Text>
            </View>
          ) : (
            <Text style={styles.muted}>Sin lugar propio.</Text>
          )}
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={() => router.push(`/tasks/${task.id}/place`)}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>{place ? 'Cambiar lugar' : 'Elegir lugar en el mapa'}</Text>
          </Pressable>

          <Text style={styles.label}>Rubro</Text>
          <CategoryChips categories={categories} selectedId={categoryId} onChange={setCategoryId} />
          <Text style={styles.hint}>
            Con rubro, avisa en cualquier local de ese tipo. Si la tarea tiene un lugar propio, se usa el lugar.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Cuándo suena
          </Text>
          <Text style={styles.hint}>
            Fuera de este horario el aviso llega igual, pero sin sonido ni vibración.
          </Text>

          <View style={styles.switchRow}>
            <Text style={styles.label}>Solo en una franja horaria</Text>
            <Switch
              value={hoursEnabled}
              onValueChange={setHoursEnabled}
              trackColor={{ true: ACCENT }}
              accessibilityLabel="Solo en una franja horaria"
            />
          </View>
          {hoursEnabled && (
            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <Text style={styles.muted}>Desde</Text>
                <TextInput
                  style={styles.timeInput}
                  value={startText}
                  onChangeText={setStartText}
                  onBlur={() => normalize(startText, setStartText)}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  placeholder="08:30"
                  accessibilityLabel="Hora de inicio"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.muted}>Hasta</Text>
                <TextInput
                  style={styles.timeInput}
                  value={endText}
                  onChangeText={setEndText}
                  onBlur={() => normalize(endText, setEndText)}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  placeholder="20:30"
                  accessibilityLabel="Hora de fin"
                />
              </View>
            </View>
          )}
          {crossesMidnight && <Text style={styles.hint}>La franja cruza la medianoche.</Text>}

          <Text style={styles.label}>Días</Text>
          <View style={styles.days} accessibilityLabel="Días en que suena">
            {WEEK_DAYS.map((day) => {
              const selected = (days & (1 << day.bit)) !== 0;
              return (
                <Pressable
                  key={day.bit}
                  style={[styles.day, selected && styles.daySelected]}
                  onPress={() => toggleDay(day.bit)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={day.name}
                >
                  <Text style={[styles.dayText, selected && styles.dayTextSelected]}>{day.short}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.presets}>
            <Pressable
              style={({ pressed }) => [styles.preset, pressed && styles.pressed]}
              onPress={() => setDays(WEEKDAYS_MASK)}
              accessibilityRole="button"
            >
              <Text style={styles.presetText}>Lun a Vie</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.preset, pressed && styles.pressed]}
              onPress={() => setDays(ALL_DAYS_MASK)}
              accessibilityRole="button"
            >
              <Text style={styles.presetText}>Todos los días</Text>
            </Pressable>
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 16 + insets.bottom }]}>
        <Pressable
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          onPress={save}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Guardar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { padding: 16, gap: 16, paddingBottom: 32 },
  title: { fontSize: 22, fontWeight: '700', color: '#0f172a' },
  section: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10 },
  sectionTitle: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  place: { gap: 2 },
  placeName: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  label: { fontWeight: '600', color: '#334155' },
  muted: { color: '#64748b' },
  hint: { color: '#94a3b8', fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1, gap: 4 },
  timeInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    fontSize: 18,
    textAlign: 'center',
  },
  days: { flexDirection: 'row', justifyContent: 'space-between' },
  day: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  daySelected: { backgroundColor: ACCENT, borderColor: ACCENT },
  dayText: { color: '#334155', fontWeight: '700' },
  dayTextSelected: { color: '#fff' },
  presets: { flexDirection: 'row', gap: 8 },
  preset: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  presetText: { color: '#334155', fontWeight: '600' },
  secondary: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  secondaryText: { color: ACCENT, fontWeight: '700' },
  error: { color: '#b91c1c' },
  footer: { padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  primary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ACCENT,
    borderRadius: 10,
  },
  primaryText: { color: '#fff', fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
