'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Loads data for a page and exposes a `reload` for use after a mutation.
 *
 * The `ignore` flag is the point. Without it, two overlapping requests resolve
 * in whatever order the network returns them, and a slow earlier response can
 * overwrite a newer one — on the Data Lapangan page, changing a filter twice
 * quickly could leave the screen showing results for the filter you just moved
 * away from. The cleanup marks in-flight work stale so only the newest response
 * is allowed to land.
 *
 * State is also only ever set after an await, never synchronously during the
 * effect, which avoids the cascading extra render on mount.
 *
 * @param {() => Promise<any>} fetcher
 * @param {Array} deps values that should trigger a refetch when they change
 */
export function useLoader(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, error: '' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let ignore = false;

    (async () => {
      try {
        const data = await fetcher();
        if (!ignore) setState({ data, error: '' });
      } catch (err) {
        if (!ignore) setState({ data: null, error: err.message });
      }
    })();

    return () => { ignore = true; };
    // `fetcher` is intentionally excluded: it is redefined on every render, so
    // including it would refetch in a loop. `deps` names what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { data: state.data, error: state.error, reload };
}
