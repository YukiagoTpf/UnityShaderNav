import { inspect } from 'node:util';
import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';

export interface EventuallyOptions {
  timeoutMs?: number;
  retryMs?: number;
}

export interface EventuallyObserver {
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
  readonly getStatus: () => Promise<IndexStatusSnapshot>;
}

class ObservationDeadlineError extends Error {
  constructor(label: string, readonly operationStarted: boolean) {
    super(`${label} did not settle before the eventual-condition deadline`);
    this.name = 'ObservationDeadlineError';
  }
}

async function beforeDeadline<T>(
  label: string,
  deadline: number,
  now: () => number,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new ObservationDeadlineError(label, false);

  let operationStarted = false;
  const observed = Promise.resolve().then(() => {
    operationStarted = true;
    return operation();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ObservationDeadlineError(label, operationStarted)),
      remaining,
    );
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function diagnosticValue(value: unknown): string {
  if (value === undefined) return '<undefined>';
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return inspect(value, { depth: 6, breakLength: 120 });
  }
}

function diagnosticError(error: unknown): string {
  if (error === undefined) return '<none>';
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return diagnosticValue(error);
}

export async function waitForEventuallyWithObserver<T>(
  observer: EventuallyObserver,
  description: string,
  query: (status: IndexStatusSnapshot | undefined) => T | PromiseLike<T>,
  predicate: (result: T) => boolean,
  options: EventuallyOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 7000;
  const retryMs = options.retryMs ?? 100;
  const deadline = observer.now() + timeoutMs;
  let lastStatus: IndexStatusSnapshot | undefined;
  let lastResult: T | undefined;
  let lastStatusError: unknown;
  let lastQueryError: unknown;

  for (;;) {
    let currentStatus: IndexStatusSnapshot | undefined;
    try {
      currentStatus = await beforeDeadline(
        'Index status request',
        deadline,
        observer.now,
        observer.getStatus,
      );
      lastStatus = currentStatus;
      lastStatusError = undefined;
    } catch (error) {
      lastStatusError = error;
      if (error instanceof ObservationDeadlineError) break;
    }

    try {
      lastResult = await beforeDeadline(
        `Query for ${description}`,
        deadline,
        observer.now,
        () => query(currentStatus),
      );
      lastQueryError = undefined;
      try {
        if (predicate(lastResult)) return lastResult;
      } catch (error) {
        lastQueryError = error;
      }
    } catch (error) {
      if (error instanceof ObservationDeadlineError && !error.operationStarted) break;
      lastQueryError = error;
    }

    if (observer.now() >= deadline) break;
    await observer.delay(Math.min(retryMs, Math.max(0, deadline - observer.now())));
  }

  throw new Error([
    `Timed out after ${timeoutMs}ms waiting for ${description}.`,
    `Last index status: ${diagnosticValue(lastStatus)}`,
    `Last status error: ${diagnosticError(lastStatusError)}`,
    `Last query result: ${diagnosticValue(lastResult)}`,
    `Last query error: ${diagnosticError(lastQueryError)}`,
  ].join('\n'));
}
