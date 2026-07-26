import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Disposable {
  dispose(): void;
}

interface Hub extends Disposable {
  on<T>(method: string, listener: (params: T) => void): Disposable;
}

interface HubModule {
  NotificationHub: new (
    registrar: (method: string, handler: (params: unknown) => void) => Disposable,
    reportError: (message: string, error: unknown) => void,
  ) => Hub;
}

const hubModule = require(
  path.join(__dirname, '..', '..', '..', 'client', 'out', 'notificationHub.js'),
) as HubModule;

interface Registration {
  readonly method: string;
  readonly handler: (params: unknown) => void;
  disposed: boolean;
}

function harness(): {
  readonly registrations: Registration[];
  readonly errors: Array<{ message: string; error: unknown }>;
  readonly hub: Hub;
  emit(method: string, params?: unknown): void;
  liveFor(method: string): Registration[];
} {
  const registrations: Registration[] = [];
  const errors: Array<{ message: string; error: unknown }> = [];
  const hub = new hubModule.NotificationHub(
    (method, handler) => {
      const registration: Registration = { method, handler, disposed: false };
      registrations.push(registration);
      return { dispose: () => { registration.disposed = true; } };
    },
    (message, error) => { errors.push({ message, error }); },
  );
  const liveFor = (method: string): Registration[] => registrations
    .filter((registration) => registration.method === method && !registration.disposed);
  return {
    registrations,
    errors,
    hub,
    emit: (method, params) => {
      for (const registration of liveFor(method)) registration.handler(params);
    },
    liveFor,
  };
}

suite('Notification hub fan-out', () => {
  test('delivers one notification to every subscriber of the same method', () => {
    const { hub, emit, registrations } = harness();
    const seen: string[] = [];
    hub.on('unityShaderNav/materialContextChanged', () => { seen.push('first'); });
    hub.on('unityShaderNav/materialContextChanged', () => { seen.push('second'); });
    hub.on('unityShaderNav/indexStatus', () => { seen.push('other-method'); });

    emit('unityShaderNav/materialContextChanged');

    // The regression this guards: LanguageClient.onNotification keeps one
    // handler per method, so a second direct registration evicted the first.
    assert.deepStrictEqual(seen, ['first', 'second']);
    assert.strictEqual(
      registrations.filter((r) => r.method === 'unityShaderNav/materialContextChanged').length,
      1,
      'the hub must hold exactly one underlying registration per method',
    );
  });

  test('passes the notification payload through unchanged', () => {
    const { hub, emit } = harness();
    const payloads: unknown[] = [];
    hub.on<{ revision: number }>('m', (params) => { payloads.push(params); });

    emit('m', { revision: 7 });

    assert.deepStrictEqual(payloads, [{ revision: 7 }]);
  });

  test('disposing one subscriber keeps the others and the registration live', () => {
    const { hub, emit, liveFor } = harness();
    const seen: string[] = [];
    const first = hub.on('m', () => { seen.push('first'); });
    hub.on('m', () => { seen.push('second'); });

    first.dispose();
    emit('m');

    assert.deepStrictEqual(seen, ['second']);
    assert.strictEqual(liveFor('m').length, 1);
  });

  test('keeps two registrations of the same function independent', () => {
    const { hub, emit } = harness();
    let calls = 0;
    const listener = (): void => { calls++; };
    const first = hub.on('m', listener);
    hub.on('m', listener);

    emit('m');
    assert.strictEqual(calls, 2);

    first.dispose();
    emit('m');
    assert.strictEqual(calls, 3);
  });

  test('releases the underlying registration only with the last subscriber', () => {
    const { hub, liveFor } = harness();
    const first = hub.on('m', () => {});
    const second = hub.on('m', () => {});

    first.dispose();
    assert.strictEqual(liveFor('m').length, 1);

    second.dispose();
    assert.strictEqual(liveFor('m').length, 0);
  });

  test('re-subscribing after the last dispose registers again', () => {
    const { hub, emit, registrations } = harness();
    const seen: string[] = [];
    // IndexStatusSession.subscribe() disposes and re-subscribes on every
    // client restart, so a released method must be able to come back.
    hub.on('m', () => { seen.push('before'); }).dispose();
    hub.on('m', () => { seen.push('after'); });

    emit('m');

    assert.deepStrictEqual(seen, ['after']);
    assert.strictEqual(registrations.filter((r) => r.method === 'm').length, 2);
  });

  test('a double dispose does not release a later subscriber', () => {
    const { hub, emit, liveFor } = harness();
    const seen: string[] = [];
    const first = hub.on('m', () => { seen.push('first'); });
    first.dispose();
    const second = hub.on('m', () => { seen.push('second'); });

    first.dispose();
    emit('m');

    assert.deepStrictEqual(seen, ['second']);
    assert.strictEqual(liveFor('m').length, 1);
    second.dispose();
  });

  test('reports a throwing listener without starving the rest', () => {
    const { hub, emit, errors } = harness();
    const seen: string[] = [];
    const failure = new Error('listener exploded');
    hub.on('m', () => { throw failure; });
    hub.on('m', () => { seen.push('second'); });

    emit('m');

    assert.deepStrictEqual(seen, ['second']);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].error, failure);
    assert.match(errors[0].message, /m notification/);
  });

  test('skips a listener disposed by an earlier listener in the same dispatch', () => {
    const { hub, emit } = harness();
    const seen: string[] = [];
    let second: Disposable | undefined;
    hub.on('m', () => {
      seen.push('first');
      second?.dispose();
    });
    second = hub.on('m', () => { seen.push('second'); });

    emit('m');

    assert.deepStrictEqual(seen, ['first']);
  });

  test('is the only place the client subscribes to a notification', () => {
    // Every eviction bug in this class came from a second direct
    // client.onNotification for a method someone else already owned. Only the
    // hub's own registrar may call it, so a new subscriber cannot reintroduce
    // the class without touching this assertion.
    const sourceDir = path.resolve(__dirname, '../../../client/src');
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(sourceDir)) {
      if (!entry.endsWith('.ts') || entry === 'extension.ts') continue;
      const text = fs.readFileSync(path.join(sourceDir, entry), 'utf8');
      if (/\.onNotification\(/.test(text)) offenders.push(entry);
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'these modules must subscribe through NotificationHub.on instead',
    );
  });

  test('disposing the hub releases every method registration', () => {
    const { hub, emit, liveFor } = harness();
    const seen: string[] = [];
    hub.on('a', () => { seen.push('a'); });
    hub.on('b', () => { seen.push('b'); });

    hub.dispose();
    emit('a');
    emit('b');

    assert.deepStrictEqual(seen, []);
    assert.strictEqual(liveFor('a').length, 0);
    assert.strictEqual(liveFor('b').length, 0);
  });
});
