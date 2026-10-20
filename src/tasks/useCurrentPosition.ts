import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

import type { Coordinates } from '../places/geo';

export type PositionStatus = 'loading' | 'ready' | 'denied' | 'unavailable';

interface PositionState {
  status: PositionStatus;
  position: Coordinates | null;
}

// Para decidir qué tareas están cerca alcanza una posición de hace unos minutos
// con precisión de barrio; pedir un fix nuevo cada vez gasta batería y demora.
const MAX_LAST_KNOWN_AGE_MS = 5 * 60_000;
const MAX_LAST_KNOWN_ACCURACY_METERS = 500;

/**
 * Lee la posición del dispositivo en primer plano.
 *
 * @pre Ninguna.
 * @post Sin permiso de ubicación devuelve `'denied'`. Con permiso, usa la última
 *       posición conocida si es reciente y precisa, y si no hay, pide un fix de
 *       precisión media; devuelve `'ready'` con la posición. Si no se pudo
 *       obtener ninguna, devuelve `null`.
 */
async function readPosition(): Promise<PositionState | null> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) return { status: 'denied', position: null };
    const fix =
      (await Location.getLastKnownPositionAsync({
        maxAge: MAX_LAST_KNOWN_AGE_MS,
        requiredAccuracy: MAX_LAST_KNOWN_ACCURACY_METERS,
      })) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return { status: 'ready', position: { latitude: fix.coords.latitude, longitude: fix.coords.longitude } };
  } catch {
    return null;
  }
}

/**
 * Combina una lectura nueva con el estado anterior.
 *
 * @pre Ninguna.
 * @post Si la lectura falló, conserva `prev` cuando ya tenía posición y si no
 *       devuelve `'unavailable'`; si no falló, devuelve la lectura.
 */
function applyReading(prev: PositionState, next: PositionState | null): PositionState {
  if (next) return next;
  return prev.position ? prev : { status: 'unavailable', position: null };
}

/**
 * Posición aproximada del dispositivo, para la pestaña «Cercanas hoy».
 *
 * @pre Se usa dentro de un componente de React.
 * @post Al montarse lee la posición con `readPosition` (`status = 'loading'`
 *       mientras tanto). `refresh` repite la lectura y, si falla, conserva la
 *       última posición obtenida.
 */
export function useCurrentPosition() {
  const [state, setState] = useState<PositionState>({ status: 'loading', position: null });

  const refresh = useCallback(async () => {
    const reading = await readPosition();
    setState((prev) => applyReading(prev, reading));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readPosition().then((reading) => {
      if (!cancelled) setState((prev) => applyReading(prev, reading));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...state, refresh };
}
