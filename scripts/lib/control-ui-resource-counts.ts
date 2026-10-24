export type ControlUiResourceCounts = {
  observers: Record<
    "ResizeObserver" | "IntersectionObserver" | "MutationObserver",
    { created: number; active: number; targets: number; callbacks: number }
  >;
  intervals: { created: number; active: number; callbacks: number };
  listeners: { window: number; document: number; mediaQuery: number };
  mediaQueries: number;
};

/** Browser init script; counts registrations without changing visibility or scheduling. */
export function installControlUiResourceCounts() {
  if (window !== window.top) {
    return;
  }
  const counter = () => ({ created: 0, active: 0, targets: 0, callbacks: 0 });
  const counts: ControlUiResourceCounts = {
    observers: {
      ResizeObserver: counter(),
      IntersectionObserver: counter(),
      MutationObserver: counter(),
    },
    intervals: { created: 0, active: 0, callbacks: 0 },
    listeners: { window: 0, document: 0, mediaQuery: 0 },
    mediaQueries: 0,
  };
  Object.defineProperty(window, "openclawResourceCounts", {
    value: () => structuredClone(counts),
    configurable: true,
  });
  for (const name of ["ResizeObserver", "IntersectionObserver", "MutationObserver"] as const) {
    const Original = window[name];
    if (!Original) {
      continue;
    }
    Reflect.set(
      window,
      name,
      new Proxy(Original, {
        construct(constructor, args, newTarget) {
          const callback = args[0];
          args[0] = function (this: unknown, ...values: unknown[]) {
            counts.observers[name].callbacks++;
            Reflect.apply(callback, this, values);
          };
          // Native constructors share observe/disconnect; only resize/intersection unobserve.
          // SAFETY: Each constructor in this fixed inventory implements these native methods.
          const observer = Reflect.construct(constructor, args, newTarget) as {
            observe(target: Node, options?: unknown): void;
            unobserve?: (target: Node) => void;
            disconnect(): void;
          };
          const targets = new Set<Node>();
          const observe = observer.observe.bind(observer);
          const disconnect = observer.disconnect.bind(observer);
          const unobserve = observer.unobserve?.bind(observer);
          const total = counts.observers[name];
          total.created++;
          observer.observe = (target, options) => {
            observe(target, options);
            if (!targets.has(target)) {
              if (targets.size === 0) {
                total.active++;
              }
              targets.add(target);
              total.targets++;
            }
          };
          observer.disconnect = () => {
            disconnect();
            if (targets.size) {
              total.active--;
              total.targets -= targets.size;
              targets.clear();
            }
          };
          if (unobserve) {
            observer.unobserve = (target) => {
              unobserve(target);
              if (targets.delete(target)) {
                total.targets--;
                if (targets.size === 0) {
                  total.active--;
                }
              }
            };
          }
          return observer;
        },
      }),
    );
  }

  // The init script runs in a browser, even though this module also has Node types.
  const browser: Window = window;
  const intervals = new Set<number>();
  const setInterval = browser.setInterval.bind(browser);
  const clearInterval = browser.clearInterval.bind(browser);
  const clearTimeout = browser.clearTimeout.bind(browser);
  browser.setInterval = (handler, timeout, ...args) => {
    const timer = setInterval(
      typeof handler === "function"
        ? (...values: unknown[]) => {
            counts.intervals.callbacks++;
            Reflect.apply(handler, window, values);
          }
        : handler,
      timeout,
      ...args,
    );
    intervals.add(timer);
    counts.intervals.created++;
    counts.intervals.active = intervals.size;
    return timer;
  };
  const retireInterval = (timer: number | undefined) => {
    if (timer !== undefined) {
      intervals.delete(timer);
      counts.intervals.active = intervals.size;
    }
  };
  browser.clearInterval = (timer) => {
    retireInterval(timer);
    clearInterval(timer);
  };
  // Browser timeout and interval handles share a pool and either clearer can cancel them.
  browser.clearTimeout = (timer) => {
    retireInterval(timer);
    clearTimeout(timer);
  };

  const mediaQueries = new WeakSet<EventTarget>();
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const media = matchMedia(query);
    mediaQueries.add(media);
    counts.mediaQueries++;
    return media;
  };
  type Listener = EventListenerOrEventListenerObject;
  type Registration = {
    type: string;
    listener: Listener;
    capture: boolean;
    wrapped: EventListener;
    remove: () => void;
  };
  const registrations = new WeakMap<EventTarget, Registration[]>();
  const add = EventTarget.prototype.addEventListener.call.bind(
    EventTarget.prototype.addEventListener,
  );
  const remove = EventTarget.prototype.removeEventListener.call.bind(
    EventTarget.prototype.removeEventListener,
  );
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const kind =
      this === window
        ? "window"
        : this === document
          ? "document"
          : mediaQueries.has(this) && type === "change"
            ? "mediaQuery"
            : undefined;
    if (!kind || !listener || (typeof options === "object" && options.signal?.aborted)) {
      return add(this, type, listener, options);
    }
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const entries = registrations.get(this) ?? [];
    const existing = entries.find(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
    );
    if (existing) {
      return add(this, type, existing.wrapped, options);
    }
    const signal = typeof options === "object" ? options.signal : undefined;
    const once = typeof options === "object" && options.once;
    const entry: Registration = {
      type,
      listener,
      capture,
      wrapped(event) {
        if (once) {
          entry.remove();
        }
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      },
      remove: () => {
        const index = entries.indexOf(entry);
        if (index >= 0) {
          entries.splice(index, 1);
          counts.listeners[kind]--;
          if (signal) {
            remove(signal, "abort", entry.remove);
          }
        }
      },
    };
    add(this, type, entry.wrapped, options);
    entries.push(entry);
    registrations.set(this, entries);
    counts.listeners[kind]++;
    if (signal) {
      add(signal, "abort", entry.remove, { once: true });
    }
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const entry = registrations
      .get(this)
      ?.find(
        (candidate) =>
          candidate.type === type &&
          candidate.listener === listener &&
          candidate.capture === capture,
      );
    if (entry) {
      entry.remove();
    }
    remove(this, type, entry?.wrapped ?? listener, options);
  };
}

export async function readControlUiResourceCounts(page: import("playwright").Page) {
  return page.evaluate(() => {
    // SAFETY: The matching init script installs this document-scoped reader before navigation.
    const read = Reflect.get(window, "openclawResourceCounts") as () => ControlUiResourceCounts;
    return read();
  });
}
