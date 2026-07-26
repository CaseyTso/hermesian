export interface AssignedValuePort<T> {
  get(): T;
  set(value: T): void;
  persist(): Promise<void>;
}

export async function assignAndPersistWithRollback<T>(
  port: AssignedValuePort<T>,
  candidate: T,
): Promise<void> {
  const previous = port.get();
  port.set(candidate);
  try {
    await port.persist();
  } catch (error) {
    if (port.get() === candidate) {
      port.set(previous);
    }
    throw error;
  }
}
