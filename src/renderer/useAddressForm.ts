import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { normalizeURL } from '../shared/validation';

export function useAddressForm(action: (url: string) => Promise<unknown>) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<'invalidURL' | 'openFailed' | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const source = useRef({ value: '', context: undefined as string | undefined });

  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const reset = useCallback((nextValue = '') => {
    request.current += 1;
    revision.current += 1;
    inFlight.current = false;
    dirty.current = false;
    source.current.value = nextValue;
    setValue(nextValue);
    setError(null);
    setPending(false);
  }, []);

  const synchronize = useCallback(
    (nextValue: string, context: string | undefined) => {
      const replace = source.current.context !== context || !dirty.current;
      source.current = { value: nextValue, context };
      if (replace) reset(nextValue);
    },
    [reset],
  );

  const change = (nextValue: string) => {
    revision.current += 1;
    dirty.current = true;
    setValue(nextValue);
    setError(null);
  };

  const submit = async () => {
    if (inFlight.current) return false;
    let url: string;
    try {
      // The main process still enforces HTTPS; loopback HTTP is used by Electron tests.
      url = normalizeURL(value, true);
    } catch {
      setError('invalidURL');
      return false;
    }
    const id = ++request.current;
    const edited = revision.current;
    const initialSource = source.current.value;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action(url);
      if (request.current !== id || revision.current !== edited) return false;
      dirty.current = false;
      setValue(source.current.value !== initialSource ? source.current.value : url);
      return true;
    } catch (failure) {
      if (request.current === id && revision.current === edited)
        setError(
          /(?:Invalid URL|HTTPS required)$/.test(String(failure)) ? 'invalidURL' : 'openFailed',
        );
      return false;
    } finally {
      if (request.current === id) {
        inFlight.current = false;
        setPending(false);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
  };

  return { value, error, pending, change, reset, synchronize, submit, onKeyDown };
}
