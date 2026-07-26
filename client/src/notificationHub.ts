interface Disposable {
  dispose(): void;
}

/**
 * Registers one underlying handler for `method`. A callback rather than a
 * structural `{ onNotification }` interface because `LanguageClient` declares
 * `onNotification` as an overload set that does not match a single signature.
 */
export type NotificationRegistrar = (
  method: string,
  handler: (params: unknown) => void,
) => Disposable;

/**
 * `vscode-languageclient` keys notification handlers by method name in a Map
 * with no fan-out, and the disposable it returns deletes whichever handler
 * currently owns that key. A second `onNotification` for the same method
 * therefore silently evicts the first, and disposing the first controller
 * unregisters the second. Every subscriber to a method that has more than one
 * listener goes through this hub instead, which holds exactly one underlying
 * registration per method and dispatches to its own listener list.
 */
export class NotificationHub implements Disposable {
  private readonly methods = new Map<string, {
    readonly registration: Disposable;
    readonly listeners: Set<(params: unknown) => void>;
  }>();

  constructor(
    private readonly registrar: NotificationRegistrar,
    private readonly reportError: (message: string, error: unknown) => void,
  ) {}

  on<T>(method: string, listener: (params: T) => void): Disposable {
    const entry = this.methods.get(method) ?? this.register(method);
    // A fresh wrapper per subscription keeps two registrations of the same
    // function independent, so disposing one does not silence the other.
    const wrapped = (params: unknown): void => { listener(params as T); };
    entry.listeners.add(wrapped);
    let disposed = false;
    return {
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        const current = this.methods.get(method);
        if (!current || !current.listeners.delete(wrapped)) return;
        if (current.listeners.size > 0) return;
        this.methods.delete(method);
        current.registration.dispose();
      },
    };
  }

  dispose(): void {
    for (const entry of this.methods.values()) {
      entry.listeners.clear();
      entry.registration.dispose();
    }
    this.methods.clear();
  }

  private register(method: string): {
    readonly registration: Disposable;
    readonly listeners: Set<(params: unknown) => void>;
  } {
    const listeners = new Set<(params: unknown) => void>();
    const registration = this.registrar(method, (params: unknown) => {
      // Iterate a copy so a listener may subscribe or dispose during dispatch,
      // and re-check membership so a listener disposed by an earlier one in the
      // same notification is not called.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener(params);
        } catch (error) {
          this.reportError(`Failed to handle the ${method} notification`, error);
        }
      }
    });
    const entry = { registration, listeners };
    this.methods.set(method, entry);
    return entry;
  }
}
