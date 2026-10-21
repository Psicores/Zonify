import { useEffect, useState } from 'react';

import { MIN_QUERY_LENGTH, type PlaceCandidate } from './model';
import { searchPlaces } from './service';

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

interface SearchState {
  /** Texto al que corresponden `results` o `failed`. */
  query: string;
  results: PlaceCandidate[];
  failed: boolean;
}

// Espera tras la última tecla antes de buscar: evita una petición por letra.
const DEBOUNCE_MS = 350;
// Siempre la misma lista vacía, para que los componentes memorizados no se redibujen.
const NO_RESULTS: readonly PlaceCandidate[] = [];

/**
 * Autocompletado de lugares mientras el usuario escribe.
 *
 * @pre Se usa dentro de un componente de React.
 * @post Con menos de `MIN_QUERY_LENGTH` caracteres útiles, `status = 'idle'` y
 *       no busca. Si no, busca `DEBOUNCE_MS` después de la última tecla
 *       (cancelando la búsqueda anterior), priorizando resultados cerca de
 *       (`nearLatitude`, `nearLongitude`) si ambos vienen. `status` es
 *       `'loading'` hasta que llega la respuesta del texto actual, y luego
 *       `'done'` con `results` o `'error'`. `results` conserva su identidad
 *       mientras no cambie (vacía es siempre el mismo arreglo).
 */
export function usePlaceSearch(query: string, nearLatitude: number | null, nearLongitude: number | null) {
  const [state, setState] = useState<SearchState>({ query: '', results: [], failed: false });
  const text = query.trim();
  const active = text.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const near =
      nearLatitude !== null && nearLongitude !== null
        ? { latitude: nearLatitude, longitude: nearLongitude }
        : null;
    const timer = setTimeout(() => {
      searchPlaces(text, near, controller.signal)
        .then((results) => setState({ query: text, results, failed: false }))
        .catch(() => {
          if (!controller.signal.aborted) setState({ query: text, results: [], failed: true });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, text, nearLatitude, nearLongitude]);

  const status: SearchStatus = !active
    ? 'idle'
    : state.query !== text
      ? 'loading'
      : state.failed
        ? 'error'
        : 'done';
  return { status, results: status === 'done' ? state.results : NO_RESULTS };
}
