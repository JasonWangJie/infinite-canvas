// Deterministic exclusive locks shared by independent localforage callers in tests.
export function browserTestLocks() {
    const queues = new Map<string, Promise<void>>();
    return {
        request<T>(name: string, options: LockOptions, callback: (lock: Lock) => Promise<T>) {
            const previous = queues.get(name) || Promise.resolve();
            let release!: () => void;
            const released = new Promise<void>((resolve) => { release = resolve; });
            queues.set(name, released);
            return previous.then(() => {
                options.signal?.throwIfAborted();
                return callback({ name, mode: "exclusive" } as Lock);
            }).finally(() => {
                release();
                if (queues.get(name) === released) queues.delete(name);
            });
        },
    } as unknown as LockManager;
}
