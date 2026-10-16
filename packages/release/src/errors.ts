/** Keep entrypoint diagnostics bounded to Error messages and fixed fallbacks. */
export function releaseFailure(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
