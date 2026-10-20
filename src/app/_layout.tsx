// Primero: define las tareas de fondo al cargar el bundle, también cuando el
// sistema despierta la app cerrada (geocercas y caché de POIs).
import '../geofencing/background';
import '../pois/background';

import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import migrations from '../../drizzle/migrations';
import { seedCatalog } from '../categories/seed';
import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { GeofenceSync } from '../geofencing/GeofenceSync';
import { PoiSync } from '../pois/PoiSync';
import { PermissionGate } from '../screens/PermissionsOnboardingScreen';

/**
 * Layout raíz: aplica las migraciones pendientes y guía los permisos antes de
 * mostrar la navegación.
 *
 * @pre `db` apunta a la base del dispositivo y `drizzle/migrations` está generado.
 * @post Mientras migra muestra un indicador de carga; si falla, muestra el error
 *       y no renderiza nada que use la base; si termina bien, el esquema está al
 *       día, los rubros del catálogo están guardados y se muestra el onboarding
 *       de permisos pendientes o, si no queda ninguno, el stack de pantallas
 *       junto con la sincronización de geocercas y del caché de POIs.
 */
export default function RootLayout() {
  const { success, error } = useMigrations(db, migrations);

  useEffect(() => {
    if (!success) return;
    try {
      seedCatalog(createRepositories(db));
    } catch (e) {
      console.warn('[categorias] no se pudo guardar el catálogo de rubros:', e);
    }
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
      <PermissionGate>
        <GeofenceSync />
        <PoiSync />
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="tasks/[id]/place" options={{ title: 'Lugar de la tarea' }} />
        </Stack>
      </PermissionGate>
      <StatusBar style="auto" />
    </SafeAreaProvider>
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
