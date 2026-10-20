// Las tareas de fondo se definen en `index.ts`, antes de cargar Expo Router.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { seedCatalog } from '../categories/seed';
import { db } from '../db/client';
import { ensureMigrated } from '../db/migrate';
import { createRepositories } from '../db/repositories';
import { GeofenceSync } from '../geofencing/GeofenceSync';
import { NotificationResponses } from '../notifications/NotificationResponses';
import { PermissionPrompter, PermissionsProvider, usePermissions } from '../permissions/PermissionsProvider';
import { PoiSync } from '../pois/PoiSync';

/**
 * Layout raíz: aplica las migraciones pendientes y muestra la navegación.
 *
 * @pre `db` apunta a la base del dispositivo y `drizzle/migrations` está generado.
 * @post Mientras migra (con `ensureMigrated`, la misma migración que usan las
 *       tareas de fondo) muestra un indicador de carga; si falla, muestra el error
 *       y no renderiza nada que use la base; si termina bien, el esquema está al
 *       día, los rubros del catálogo están guardados y se muestra `AppStack`
 *       directamente, sin pedir permisos (US-3.1). Cuando la interfaz queda
 *       libre, borra el historial de avisos de más de 30 días (US-2.3).
 */
export default function RootLayout() {
  const [{ success, error }, setMigration] = useState<{ success: boolean; error: Error | null }>({
    success: false,
    error: null,
  });

  useEffect(() => {
    ensureMigrated().then(
      () => setMigration({ success: true, error: null }),
      (e: unknown) => setMigration({ success: false, error: e instanceof Error ? e : new Error(String(e)) }),
    );
  }, []);

  useEffect(() => {
    if (!success) return;
    const repos = createRepositories(db);
    try {
      seedCatalog(repos);
    } catch (e) {
      console.warn('[categorias] no se pudo guardar el catálogo de rubros:', e);
    }
    // La poda no tiene apuro: corre cuando el hilo de JS no está dibujando.
    const purge = requestIdleCallback(() => {
      repos.notificationLogs
        .purgeOldNotificationLogs()
        .then((deleted) => {
          if (__DEV__ && deleted > 0) console.log('[avisos] historial podado:', deleted);
        })
        .catch((e: unknown) => console.warn('[avisos] no se pudo podar el historial:', e));
    });
    return () => cancelIdleCallback(purge);
  }, [success]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Error al migrar la base de datos local</Text>
        <Text>{error.message}</Text>
      </View>
    );
  }

  if (!success) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <PermissionsProvider>
        <AppStack />
      </PermissionsProvider>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

/**
 * Pantallas de la app y tareas que no dibujan nada (geocercas, caché de POIs,
 * toques en los avisos, apertura del modal de permisos).
 *
 * @pre Se monta dentro de `PermissionsProvider`.
 * @post La lista de tareas es la primera pantalla. La ruta `permissions` solo
 *       está habilitada (`Stack.Protected`) mientras hay un pedido de permisos
 *       abierto (`prompting`); cuando se resuelve, Expo Router la saca del
 *       historial y el modal se cierra solo.
 */
function AppStack() {
  const { prompting } = usePermissions();
  return (
    <>
      <GeofenceSync />
      <PoiSync />
      <NotificationResponses />
      <PermissionPrompter />
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="tasks/[id]/index" options={{ title: 'Tarea' }} />
        <Stack.Screen name="tasks/[id]/place" options={{ title: 'Lugar de la tarea' }} />
        <Stack.Screen name="settings" options={{ title: 'Ajustes' }} />
        <Stack.Protected guard={prompting}>
          <Stack.Screen name="permissions" options={{ presentation: 'modal', headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  error: {
    fontWeight: '600',
    color: '#b91c1c',
  },
});
