import { count } from 'drizzle-orm';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { db } from '../db/client';
import { createRepositories, type Repositories } from '../db/repositories';
import { categories, geofenceTriggers, locationTargets, notificationLogs, tasks } from '../db/schema';

const TABLES = { categories, locationTargets, tasks, geofenceTriggers, notificationLogs };

interface ProbeResult {
  writeMs: number;
  readMs: number;
  totalMs: number;
}

/**
 * Cuenta las filas de cada tabla.
 *
 * @pre Las migraciones están aplicadas sobre `db`.
 * @post Devuelve un objeto `{ nombreTabla: cantidad }` con una entrada por tabla de `TABLES`.
 */
async function countRows() {
  const entries = await Promise.all(
    Object.entries(TABLES).map(async ([name, table]) => {
      const [row] = await db.select({ value: count() }).from(table);
      return [name, row.value] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Mide una escritura, una lectura y un borrado sobre la base real.
 *
 * @pre Las migraciones están aplicadas sobre la base de `repos`.
 * @post Devuelve los tiempos en ms de la escritura, la lectura y el total. La
 *       tarea de prueba se borra, así que la base queda como estaba.
 * @throws Error si la tarea recién escrita no se puede leer.
 */
async function probeRoundTrip(repos: Repositories): Promise<ProbeResult> {
  const start = performance.now();
  const task = await repos.tasks.create({ title: 'Sonda de diagnóstico' });
  const written = performance.now();
  const loaded = await repos.tasks.getById(task.id);
  const read = performance.now();
  if (!loaded) throw new Error('La tarea escrita no se pudo leer');
  await repos.tasks.remove(task.id);
  return { writeMs: written - start, readMs: read - written, totalMs: performance.now() - start };
}

/**
 * Pantalla temporal de desarrollo (US-1.1): muestra las filas por tabla y mide
 * escritura → lectura → borrado en la base del dispositivo.
 *
 * @pre Se renderiza dentro de `SafeAreaProvider` y con las migraciones aplicadas.
 * @post Al montarse ejecuta una medición; cada toque en "Repetir prueba" ejecuta otra.
 *       Muestra los últimos tiempos, o el error si la medición falló.
 */
export function DatabaseDiagnosticsScreen() {
  const repos = useMemo(() => createRepositories(db), []);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Lanza una medición y actualiza el estado con el resultado.
   *
   * @pre El componente está montado.
   * @post Al terminar con éxito, `probe` y `counts` tienen los valores nuevos y
   *       `error` es `null`; si falla, `error` tiene el mensaje y el resto no cambia.
   */
  const runProbe = useCallback(() => {
    probeRoundTrip(repos)
      .then(async (result) => {
        setProbe(result);
        setCounts(await countRows());
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [repos]);

  useEffect(runProbe, [runProbe]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Zonify · Base de datos local</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Filas por tabla</Text>
          {Object.entries(counts).map(([name, value]) => (
            <View key={name} style={styles.row}>
              <Text>{name}</Text>
              <Text style={styles.mono}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Latencia (escritura → lectura → borrado)</Text>
          {probe && (
            <>
              <Metric label="Escritura" ms={probe.writeMs} />
              <Metric label="Lectura" ms={probe.readMs} />
              <Metric label="Total" ms={probe.totalMs} />
            </>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        <Pressable style={styles.button} onPress={runProbe}>
          <Text style={styles.buttonText}>Repetir prueba</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Fila con el nombre y el valor de una métrica de latencia.
 *
 * @pre `ms` es un número finito no negativo.
 * @post Muestra `ms` con dos decimales, en rojo si supera 16 ms (un frame a 60 fps).
 */
function Metric({ label, ms }: { label: string; ms: number }) {
  return (
    <View style={styles.row}>
      <Text>{label}</Text>
      <Text style={[styles.mono, ms > 16 && styles.error]}>{ms.toFixed(2)} ms</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, gap: 16 },
  title: { fontSize: 20, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 8 },
  cardTitle: { fontWeight: '600', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  mono: { fontVariant: ['tabular-nums'] },
  error: { color: '#b91c1c' },
  button: { backgroundColor: '#0f766e', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
