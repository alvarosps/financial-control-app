import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let current = new URLSearchParams();

export function setFakeSearchParams(queryString: string): void {
  current = new URLSearchParams(queryString);
  for (const listener of listeners) listener();
}

export function resetFakeSearchParams(): void {
  setFakeSearchParams('');
}

export function useFakeSearchParams(): URLSearchParams {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
    () => current,
  );
}

export function installHistorySync(): () => void {
  const original = window.history.replaceState.bind(window.history);
  window.history.replaceState = (data, unused, url) => {
    // Next skips router synchronization for its own internal history entries.
    const internal = data?.__NA || data?._N;
    original({ ...data, __NA: true }, unused, url);
    if (!internal) setFakeSearchParams(window.location.search);
  };
  window.history.replaceState(null, '', window.location.href);
  return () => {
    window.history.replaceState = original;
  };
}
