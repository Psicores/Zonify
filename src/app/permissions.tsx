import { PermissionsOnboardingScreen } from '../screens/PermissionsOnboardingScreen';

/**
 * Ruta del modal de permisos (US-3.1). El layout raíz la protege: solo está
 * habilitada mientras hay un pedido de permisos abierto.
 *
 * @pre Ninguna.
 * @post Muestra `PermissionsOnboardingScreen`.
 */
export default function PermissionsRoute() {
  return <PermissionsOnboardingScreen />;
}
