import { useEffect } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  groupOf,
  type BatteryStatus,
  type OnboardingStep,
  type PermissionDemand,
  type PermissionGroup,
} from '../permissions/model';
import { usePermissions } from '../permissions/PermissionsProvider';
import {
  openAppSettings,
  openBatteryOptimizationSettings,
  openPowerSaverSettings,
  openVendorGuide,
} from '../permissions/service';
import type { PermissionFlow } from '../permissions/usePermissionFlow';

type PendingStep = Exclude<OnboardingStep, 'done'>;

interface StepAction {
  label: string;
  onPress: () => void;
  kind: 'primary' | 'secondary' | 'link';
}

interface StepContent {
  title: string;
  body: string[];
  /** Instrucción concreta para el diálogo o la pantalla de Ajustes que se va a abrir. */
  hint?: string;
  actions: StepAction[];
}

const GROUPS: PermissionGroup[] =
  Platform.OS === 'android' ? ['location', 'notifications', 'battery'] : ['location', 'notifications'];

/**
 * Modal del pedido de permisos abierto (US-1.2, US-3.1). Es la pantalla de la
 * ruta protegida `/permissions`: solo existe mientras `prompting` es `true`.
 *
 * @pre Se renderiza dentro de `PermissionsProvider` y de `SafeAreaProvider`.
 * @post Muestra el paso pendiente del pedido; cuando se resuelve (permiso
 *       concedido o «Ahora no») la ruta deja de estar habilitada y Expo Router
 *       la cierra. Al desmontarse cierra el pedido: si el usuario salió con
 *       «atrás» sin resolverlo, cuenta como «Ahora no».
 */
export function PermissionsOnboardingScreen() {
  const flow = usePermissions();
  const { release } = flow;

  useEffect(() => release, [release]);

  if (!flow.snapshot || !flow.demand || !flow.step || flow.step === 'done') {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  return <PermissionStep flow={flow} demand={flow.demand} step={flow.step} battery={flow.snapshot.battery} />;
}

/**
 * Un paso del pedido: explica para qué se usa el permiso antes de mostrar el
 * diálogo nativo, y ofrece ir a Ajustes cuando el sistema ya no permite volver
 * a pedirlo.
 *
 * @pre `step` es el paso pendiente de `demand`, y `battery` el estado de batería del snapshot.
 * @post Muestra el progreso (solo en el pedido de avisos, que tiene varios
 *       pasos), el texto y las acciones del paso; mientras hay una solicitud en
 *       curso, las acciones están deshabilitadas.
 */
function PermissionStep({
  flow,
  demand,
  step,
  battery,
}: {
  flow: PermissionFlow;
  demand: PermissionDemand;
  step: PendingStep;
  battery: BatteryStatus;
}) {
  const content = stepContent(step, demand, flow, battery);
  const position = GROUPS.indexOf(groupOf(step)) + 1;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {demand === 'alerts' && (
          <Text style={styles.progress}>
            Paso {position} de {GROUPS.length}
          </Text>
        )}
        <Text style={styles.title}>{content.title}</Text>

        {content.body.map((paragraph) => (
          <Text key={paragraph} style={styles.body}>
            {paragraph}
          </Text>
        ))}

        {content.hint && (
          <View style={styles.hint}>
            <Text style={styles.hintText}>{content.hint}</Text>
          </View>
        )}

        {flow.error && <Text style={styles.error}>{flow.error}</Text>}
      </ScrollView>

      <View style={styles.actions}>
        {content.actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            disabled={flow.busy}
            onPress={action.onPress}
            style={({ pressed }) => [
              styles[action.kind],
              (pressed || flow.busy) && styles.dimmed,
            ]}>
            <Text style={styles[`${action.kind}Text`]}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

/**
 * Texto y acciones de cada paso, con instrucciones específicas de cada plataforma.
 *
 * @pre Ninguna.
 * @post Devuelve un contenido con al menos una acción; la última siempre
 *       permite posponer el grupo del paso. La ubicación se explica según el
 *       pedido: para el mapa o para los avisos con la app cerrada.
 */
function stepContent(
  step: PendingStep,
  demand: PermissionDemand,
  flow: PermissionFlow,
  battery: BatteryStatus,
): StepContent {
  const settings: StepAction = {
    label: 'Abrir Ajustes',
    onPress: () => flow.openSettings(openAppSettings),
    kind: 'primary',
  };
  /**
   * Acción para posponer el grupo del paso actual.
   *
   * @pre Ninguna.
   * @post Devuelve una acción de tipo enlace que llama a `flow.skip(groupOf(step))`.
   */
  const skip = (label: string): StepAction => ({
    label,
    onPress: () => flow.skip(groupOf(step)),
    kind: 'link',
  });

  switch (step) {
    case 'intro':
      if (demand === 'location') {
        return {
          title: 'Ubicación para el mapa',
          body: [
            'Con tu ubicación, el mapa se abre donde estás y la búsqueda muestra primero los lugares cercanos.',
            'Solo se usa mientras tienes Zonify abierta, y se procesa en el teléfono: no la compartimos con nadie. También puedes buscar un lugar sin darla.',
          ],
          actions: [
            { label: 'Permitir ubicación', onPress: flow.requestForeground, kind: 'primary' },
            skip('Ahora no'),
          ],
        };
      }
      return {
        title: 'Avisos al llegar a cada lugar',
        body: [
          'Zonify te recuerda tus tareas cuando llegas o sales de un lugar que elegiste, como el supermercado o la oficina. Para eso necesita tu ubicación también cuando la app está cerrada: es lo que el sistema llama «Ubicación todo el tiempo».',
          'Tu ubicación solo se compara con los lugares que guardaste y se procesa en el teléfono: no la compartimos con nadie.',
          'Te pediremos el permiso en dos pasos: primero mientras usas la app y después todo el tiempo.',
        ],
        actions: [
          { label: 'Permitir ubicación', onPress: flow.requestForeground, kind: 'primary' },
          skip('Ahora no'),
        ],
      };

    case 'foreground-blocked':
      return {
        title: 'La ubicación está desactivada para Zonify',
        body: [
          demand === 'location'
            ? 'Sin ubicación, el mapa no puede mostrarte dónde estás, y el sistema ya no permite volver a pedir el permiso desde la app.'
            : 'Sin ubicación, Zonify no puede saber cuándo llegas a tus lugares, y el sistema ya no permite volver a pedir el permiso desde la app.',
        ],
        hint:
          demand === 'location'
            ? Platform.select({
                ios: 'En Ajustes, toca «Ubicación» y elige «Al usar la app».',
                default: 'En Ajustes, toca «Permisos» › «Ubicación» y elige «Permitir solo con la app en uso».',
              })
            : Platform.select({
                ios: 'En Ajustes, toca «Ubicación» y elige «Siempre».',
                default: 'En Ajustes, toca «Permisos» › «Ubicación» y elige «Permitir todo el tiempo».',
              }),
        actions: [settings, skip(demand === 'location' ? 'Continuar sin ubicación' : 'Continuar sin alertas')],
      };

    case 'precise-required':
      return {
        title: 'Activa la ubicación precisa',
        body: [
          'Con la ubicación aproximada el sistema no puede detectar cuándo entras o sales de un lugar, así que las alertas no se dispararían.',
        ],
        hint: Platform.select({
          ios: 'En Ajustes, toca «Ubicación» y activa «Ubicación exacta».',
          default: 'En Ajustes, toca «Permisos» › «Ubicación» y activa «Usar ubicación precisa».',
        }),
        actions: [settings, skip('Continuar sin alertas')],
      };

    case 'background':
      return {
        title: 'Ubicación todo el tiempo',
        body: [
          'Para avisarte aunque Zonify esté cerrada, el sistema tiene que dejarle ver tu ubicación en segundo plano. Solo la usamos para detectar tus lugares, no para registrar tu recorrido.',
        ],
        hint: Platform.select({
          ios: 'En el aviso que aparecerá, elige «Cambiar a Permitir siempre».',
          default: 'En la pantalla que se abrirá, elige «Permitir todo el tiempo» y vuelve a Zonify.',
        }),
        actions: [
          { label: 'Continuar', onPress: flow.requestBackground, kind: 'primary' },
          skip('Ahora no'),
        ],
      };

    case 'background-denied':
      return {
        title: 'Las alertas no funcionarán con la app cerrada',
        body: [
          'Zonify solo puede ver tu ubicación mientras la usas, así que no podrá avisarte al llegar a un lugar si está en segundo plano o cerrada.',
          'Puedes cambiarlo cuando quieras desde los Ajustes del sistema.',
        ],
        hint: Platform.select({
          ios: 'En Ajustes, toca «Ubicación» y elige «Siempre».',
          default: 'En Ajustes, toca «Permisos» › «Ubicación» y elige «Permitir todo el tiempo».',
        }),
        actions: [settings, skip('Continuar con funciones limitadas')],
      };

    case 'notifications':
      return {
        title: 'Activa las notificaciones',
        body: [
          'Es la forma en que Zonify te avisa cuando llegas a un lugar con tareas pendientes. Solo te enviaremos avisos de tus propias tareas.',
        ],
        actions: [
          { label: 'Permitir notificaciones', onPress: flow.requestNotifications, kind: 'primary' },
          skip('Ahora no'),
        ],
      };

    case 'notifications-denied':
      return {
        title: 'Las notificaciones están desactivadas',
        body: ['Zonify detectará cuando llegas a un lugar, pero no tendrá forma de avisarte.'],
        hint: 'En Ajustes, toca «Notificaciones» y actívalas.',
        actions: [settings, skip('Continuar sin notificaciones')],
      };

    case 'battery':
      return batteryContent(flow, battery, skip('Continuar de todos modos'));
  }
}

/**
 * Contenido del paso de batería según las restricciones detectadas.
 *
 * @pre `battery` tiene al menos una restricción activa.
 * @post Devuelve un párrafo y una acción por cada restricción detectada, la guía
 *       del fabricante si es conocido, y `skip` como última acción.
 */
function batteryContent(flow: PermissionFlow, battery: BatteryStatus, skip: StepAction): StepContent {
  const { optimized, powerSaver, vendor } = battery;
  const body = ['Detectamos ajustes de batería que pueden impedir que Zonify te avise a tiempo:'];
  const actions: StepAction[] = [];

  if (optimized) {
    body.push(
      '• La optimización de batería está activa para Zonify: Android puede retrasar o descartar las alertas con la pantalla apagada.',
    );
    actions.push({
      label: 'Quitar optimización',
      onPress: () => flow.openSettings(openBatteryOptimizationSettings),
      kind: 'primary',
    });
  }
  if (powerSaver) {
    body.push('• El ahorro de batería está activado y limita la ubicación en segundo plano.');
    actions.push({
      label: 'Abrir ahorro de batería',
      onPress: () => flow.openSettings(openPowerSaverSettings),
      kind: optimized ? 'secondary' : 'primary',
    });
  }
  if (vendor) {
    body.push(
      `Además, los teléfonos ${vendor.name} tienen restricciones propias (inicio automático, apps en suspensión) que la app no puede detectar. La guía explica cómo desactivarlas.`,
    );
    actions.push({
      label: `Ver guía para ${vendor.name}`,
      onPress: () => flow.openSettings(() => openVendorGuide(vendor.slug)),
      kind: 'secondary',
    });
  }

  return {
    title: 'Tu teléfono puede pausar Zonify',
    body,
    hint: optimized
      ? 'En la lista, muestra «Todas las apps», toca Zonify y elige «No optimizar».'
      : undefined,
    actions: [...actions, skip],
  };
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 24, gap: 16 },
  progress: { color: '#0f766e', fontWeight: '600' },
  title: { fontSize: 24, fontWeight: '700', color: '#0f172a' },
  body: { fontSize: 16, lineHeight: 24, color: '#334155' },
  hint: { backgroundColor: '#ccfbf1', borderRadius: 12, padding: 16 },
  hintText: { fontSize: 15, lineHeight: 22, color: '#134e4a' },
  error: { color: '#b91c1c' },
  actions: { padding: 24, paddingTop: 8, gap: 12 },
  primary: { backgroundColor: '#0f766e', borderRadius: 10, padding: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondary: { borderColor: '#0f766e', borderWidth: 1, borderRadius: 10, padding: 14, alignItems: 'center' },
  secondaryText: { color: '#0f766e', fontWeight: '600', fontSize: 16 },
  link: { padding: 10, alignItems: 'center' },
  linkText: { color: '#475569', fontSize: 15 },
  dimmed: { opacity: 0.6 },
});
