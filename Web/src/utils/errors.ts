export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'object' && error !== null && 'message' in error &&
      typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return fallback;
};

export const isCancellationError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error &&
  (error.name === 'CanceledError' || error.name === 'AbortError');
