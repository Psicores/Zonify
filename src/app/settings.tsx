import { SettingsScreen } from '../screens/SettingsScreen';

/**
 * Ruta `/settings`: ajustes de los avisos.
 *
 * @pre Se renderiza dentro del layout raíz (migraciones aplicadas).
 * @post Muestra `SettingsScreen`.
 */
export default function SettingsRoute() {
  return <SettingsScreen />;
}
