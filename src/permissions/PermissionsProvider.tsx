import { router, type Href } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { usePermissionFlow, type PermissionFlow } from './usePermissionFlow';

/** Ruta del modal de permisos (`src/app/permissions.tsx`). */
export const PERMISSIONS_ROUTE = '/permissions' satisfies Href;

const PermissionsContext = createContext<PermissionFlow | null>(null);

/**
 * Comparte el estado de los permisos con toda la app (US-3.1).
 *
 * @pre Se monta con las migraciones aplicadas, dentro del layout raíz.
 * @post Los descendientes leen y abren pedidos con `usePermissions`.
 */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const repos = useMemo(() => createRepositories(db), []);
  const flow = usePermissionFlow(repos);
  return <PermissionsContext.Provider value={flow}>{children}</PermissionsContext.Provider>;
}

/**
 * Estado de los permisos y pedidos abiertos.
 *
 * @pre Se usa dentro de `PermissionsProvider`.
 * @post Devuelve el flujo compartido.
 * @throws `Error` si no hay `PermissionsProvider` arriba.
 */
export function usePermissions(): PermissionFlow {
  const flow = useContext(PermissionsContext);
  if (!flow) throw new Error('usePermissions necesita un PermissionsProvider');
  return flow;
}

/**
 * Abre el modal de permisos cuando se abre un pedido. No dibuja nada.
 *
 * @pre Se monta dentro de `PermissionsProvider`, junto al stack del layout raíz,
 *      cuya ruta `PERMISSIONS_ROUTE` está protegida por `prompting`.
 * @post Cada vez que `prompting` pasa a `true` navega a `PERMISSIONS_ROUTE`. Lo
 *       hace un cuadro después: la ruta protegida tiene que estar habilitada
 *       antes de navegar, o Expo Router redirige al inicio. Cerrarlo no hace
 *       falta: cuando `prompting` vuelve a `false`, Expo Router saca la ruta.
 */
export function PermissionPrompter() {
  const { prompting } = usePermissions();

  useEffect(() => {
    if (!prompting) return;
    const frame = requestAnimationFrame(() => router.push(PERMISSIONS_ROUTE));
    return () => cancelAnimationFrame(frame);
  }, [prompting]);

  return null;
}
