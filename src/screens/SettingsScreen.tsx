import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { getPoiCooldownHours, POI_COOLDOWN_OPTIONS, setPoiCooldownHours } from '../settings/appSettings';

const ACCENT = '#0f766e';

/**
 * Ajustes de los avisos (US-6.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Muestra el enfriamiento por local guardado y permite cambiarlo entre
 *       `POI_COOLDOWN_OPTIONS`; cada toque lo guarda en el momento. Si falla,
 *       muestra el error y conserva el valor anterior.
 */
export function SettingsScreen() {
  const repos = useMemo(() => createRepositories(db), []);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPoiCooldownHours(repos)
      .then((hours) => {
        if (!cancelled) setCooldown(hours);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`No se pudieron leer los ajustes: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [repos]);

  /**
   * Guarda un enfriamiento nuevo.
   *
   * @pre `hours` está en `POI_COOLDOWN_OPTIONS`.
   * @post Si se guarda, `cooldown = hours`; si falla, `error` tiene el mensaje.
   */
  const choose = async (hours: number) => {
    try {
      await setPoiCooldownHours(repos, hours);
      setCooldown(hours);
      setError(null);
    } catch (e) {
      setError(`No se pudo guardar: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Después de avisar en un local
        </Text>
        <Text style={styles.muted}>
          Un mismo local o lugar no vuelve a avisar durante este tiempo, aunque pases varias veces por la puerta.
        </Text>
        <View style={styles.options} accessibilityRole="radiogroup">
          {POI_COOLDOWN_OPTIONS.map((hours) => {
            const selected = hours === cooldown;
            return (
              <Pressable
                key={hours}
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => choose(hours)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`${hours} horas`}
              >
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{hours} h</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Posponer
        </Text>
        <Text style={styles.muted}>
          «Posponer 2 h» en un aviso silencia esa tarea y todo su rubro durante 2 horas.
        </Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  section: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10 },
  sectionTitle: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  muted: { color: '#64748b' },
  options: { flexDirection: 'row', gap: 8 },
  option: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  optionSelected: { backgroundColor: ACCENT, borderColor: ACCENT },
  optionText: { color: '#334155', fontWeight: '700' },
  optionTextSelected: { color: '#fff' },
  error: { color: '#b91c1c' },
});
