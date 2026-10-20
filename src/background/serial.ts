/** Ejecuta un trabajo cuando terminaron todos los anteriores de la misma cola. */
export type SerialQueue = <T>(job: () => Promise<T>) => Promise<T>;

/**
 * Crea una cola que ejecuta trabajos asíncronos de a uno, en orden de llegada.
 *
 * @pre Ninguna.
 * @post Cada trabajo empieza cuando terminó el anterior, haya salido bien o mal,
 *       y la promesa devuelta resuelve o rechaza con el resultado del propio
 *       trabajo. Un fallo no frena a los siguientes. Solo serializa dentro de un
 *       mismo runtime de JS. Un trabajo no debe esperar a otro de su misma cola:
 *       quedaría bloqueado para siempre.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job, job);
    tail = result.catch(() => undefined);
    return result;
  };
}

// Dos colas independientes: un evento de la centinela replanifica (sincroniza)
// mientras ocupa `eventQueue`; con una sola cola se esperaría a sí mismo.

/**
 * Eventos de geocercas y botones de los avisos (US-2.1): cada uno lee el
 * historial de avisos y escribe en él, así que el siguiente ve lo que escribió
 * el anterior (enfriamientos, tareas completadas o pospuestas).
 */
export const eventQueue = createSerialQueue();

/** Registros de geocercas en el sistema operativo (`syncGeofences`). */
export const syncQueue = createSerialQueue();
