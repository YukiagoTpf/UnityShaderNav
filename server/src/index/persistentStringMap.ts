interface Node<T> {
  readonly key: string;
  readonly value: T;
  readonly priority: number;
  readonly left: Node<T> | undefined;
  readonly right: Node<T> | undefined;
}

interface SetResult<T> {
  readonly node: Node<T>;
  readonly added: boolean;
  readonly changed: boolean;
}

interface DeleteResult<T> {
  readonly node: Node<T> | undefined;
  readonly deleted: boolean;
}

/**
 * Immutable string-keyed treap. Updates copy only one search path, so a fork
 * can retain the previous root in O(1) while later writes remain isolated.
 */
export class PersistentStringMap<T> {
  private constructor(
    private readonly root: Node<T> | undefined,
    readonly size: number,
  ) {}

  static empty<T>(): PersistentStringMap<T> {
    return new PersistentStringMap<T>(undefined, 0);
  }

  get(key: string): T | undefined {
    let current = this.root;
    while (current) {
      if (key === current.key) return current.value;
      current = key < current.key ? current.left : current.right;
    }
    return undefined;
  }

  has(key: string): boolean {
    let current = this.root;
    while (current) {
      if (key === current.key) return true;
      current = key < current.key ? current.left : current.right;
    }
    return false;
  }

  set(key: string, value: T): PersistentStringMap<T> {
    const result = setNode(this.root, key, value);
    if (!result.changed) return this;
    return new PersistentStringMap(result.node, this.size + Number(result.added));
  }

  delete(key: string): PersistentStringMap<T> {
    const result = deleteNode(this.root, key);
    return result.deleted
      ? new PersistentStringMap(result.node, this.size - 1)
      : this;
  }

  *entries(): IterableIterator<readonly [string, T]> {
    const stack: Node<T>[] = [];
    let current = this.root;
    while (current || stack.length > 0) {
      while (current) {
        stack.push(current);
        current = current.left;
      }
      const next = stack.pop()!;
      yield [next.key, next.value] as const;
      current = next.right;
    }
  }

  *values(): IterableIterator<T> {
    for (const [, value] of this.entries()) yield value;
  }
}

interface OrderedEntry<T> {
  readonly order: number;
  readonly value: T;
}

/** Persistent map whose iteration matches JavaScript Map insertion order. */
export class PersistentOrderedMap<T> {
  private constructor(
    private readonly entriesByKey: PersistentStringMap<OrderedEntry<T>>,
    private readonly keysByOrder: PersistentStringMap<string>,
    private readonly nextOrder: number,
  ) {}

  static empty<T>(): PersistentOrderedMap<T> {
    return new PersistentOrderedMap(
      PersistentStringMap.empty(),
      PersistentStringMap.empty(),
      0,
    );
  }

  get size(): number {
    return this.entriesByKey.size;
  }

  get(key: string): T | undefined {
    return this.entriesByKey.get(key)?.value;
  }

  has(key: string): boolean {
    return this.entriesByKey.has(key);
  }

  set(key: string, value: T): PersistentOrderedMap<T> {
    const previous = this.entriesByKey.get(key);
    if (previous && Object.is(previous.value, value)) return this;
    const order = previous?.order ?? this.nextOrder;
    const entriesByKey = this.entriesByKey.set(key, Object.freeze({ order, value }));
    if (entriesByKey === this.entriesByKey) return this;
    return new PersistentOrderedMap(
      entriesByKey,
      previous
        ? this.keysByOrder
        : this.keysByOrder.set(orderKey(order), key),
      previous ? this.nextOrder : this.nextOrder + 1,
    );
  }

  delete(key: string): PersistentOrderedMap<T> {
    const previous = this.entriesByKey.get(key);
    if (!previous) return this;
    const entriesByKey = this.entriesByKey.delete(key);
    return new PersistentOrderedMap(
      entriesByKey,
      this.keysByOrder.delete(orderKey(previous.order)),
      this.nextOrder,
    );
  }

  *entries(): IterableIterator<readonly [string, T]> {
    for (const key of this.keysByOrder.values()) {
      yield [key, this.entriesByKey.get(key)!.value] as const;
    }
  }

  *values(): IterableIterator<T> {
    for (const [, value] of this.entries()) yield value;
  }
}

function orderKey(order: number): string {
  return order.toString(16).padStart(14, '0');
}

function setNode<T>(
  current: Node<T> | undefined,
  key: string,
  value: T,
): SetResult<T> {
  if (!current) {
    return {
      node: createNode(key, value, priorityOf(key), undefined, undefined),
      added: true,
      changed: true,
    };
  }
  if (key === current.key) {
    if (Object.is(value, current.value)) {
      return { node: current, added: false, changed: false };
    }
    return {
      node: createNode(
        current.key,
        value,
        current.priority,
        current.left,
        current.right,
      ),
      added: false,
      changed: true,
    };
  }

  if (key < current.key) {
    const result = setNode(current.left, key, value);
    if (!result.changed) {
      return { node: current, added: result.added, changed: false };
    }
    const next = createNode(
      current.key,
      current.value,
      current.priority,
      result.node,
      current.right,
    );
    return {
      node: precedes(result.node, next) ? rotateRight(next) : next,
      added: result.added,
      changed: true,
    };
  }

  const result = setNode(current.right, key, value);
  if (!result.changed) {
    return { node: current, added: result.added, changed: false };
  }
  const next = createNode(
    current.key,
    current.value,
    current.priority,
    current.left,
    result.node,
  );
  return {
    node: precedes(result.node, next) ? rotateLeft(next) : next,
    added: result.added,
    changed: true,
  };
}

function deleteNode<T>(current: Node<T> | undefined, key: string): DeleteResult<T> {
  if (!current) return { node: undefined, deleted: false };
  if (key === current.key) {
    return { node: merge(current.left, current.right), deleted: true };
  }
  if (key < current.key) {
    const result = deleteNode(current.left, key);
    return result.deleted
      ? {
        node: createNode(
          current.key,
          current.value,
          current.priority,
          result.node,
          current.right,
        ),
        deleted: true,
      }
      : { node: current, deleted: false };
  }
  const result = deleteNode(current.right, key);
  return result.deleted
    ? {
      node: createNode(
        current.key,
        current.value,
        current.priority,
        current.left,
        result.node,
      ),
      deleted: true,
    }
    : { node: current, deleted: false };
}

function merge<T>(left: Node<T> | undefined, right: Node<T> | undefined): Node<T> | undefined {
  if (!left) return right;
  if (!right) return left;
  if (precedes(left, right)) {
    return createNode(
      left.key,
      left.value,
      left.priority,
      left.left,
      merge(left.right, right),
    );
  }
  return createNode(
    right.key,
    right.value,
    right.priority,
    merge(left, right.left),
    right.right,
  );
}

function rotateRight<T>(current: Node<T>): Node<T> {
  const left = current.left!;
  return createNode(
    left.key,
    left.value,
    left.priority,
    left.left,
    createNode(
      current.key,
      current.value,
      current.priority,
      left.right,
      current.right,
    ),
  );
}

function rotateLeft<T>(current: Node<T>): Node<T> {
  const right = current.right!;
  return createNode(
    right.key,
    right.value,
    right.priority,
    createNode(
      current.key,
      current.value,
      current.priority,
      current.left,
      right.left,
    ),
    right.right,
  );
}

function createNode<T>(
  key: string,
  value: T,
  priority: number,
  left: Node<T> | undefined,
  right: Node<T> | undefined,
): Node<T> {
  return Object.freeze({ key, value, priority, left, right });
}

function precedes<T>(left: Node<T>, right: Node<T>): boolean {
  return left.priority < right.priority
    || (left.priority === right.priority && left.key < right.key);
}

function priorityOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
