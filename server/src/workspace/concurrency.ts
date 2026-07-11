export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let hasFailure = false;
  let firstFailure: unknown;

  async function worker(): Promise<void> {
    while (!hasFailure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hasFailure) throw firstFailure;
  return results;
}
