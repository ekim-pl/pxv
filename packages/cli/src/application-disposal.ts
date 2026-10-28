import type { Store } from '@pxv/runtime';

interface ApplicationFailure {
  error: unknown;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Operation failed';
}
/** Preserve the primary failure without serializing command results or application state. */
export async function disposeApplication(
  store: Pick<Store, 'close'>,
  failure?: ApplicationFailure,
): Promise<void> {
  try {
    await store.close();
  } catch (error) {
    if (failure)
      throw new AggregateError(
        [failure.error, error],
        `Application failed: ${message(failure.error)}; storage disposal failed: ${message(error)}`,
        { cause: failure.error },
      );
    throw error;
  }
}
export async function usingApplicationStore<T>(
  store: Pick<Store, 'close'>,
  action: () => Promise<T>,
): Promise<T> {
  let failure: ApplicationFailure | undefined;
  try {
    return await action();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await disposeApplication(store, failure);
  }
}
