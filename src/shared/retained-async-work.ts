import { AsyncWorkScope } from "./async-work-scope.js";

/** Retained owners share a work phase; the last release drains only that phase. */
export class RetainedAsyncWork {
  private work = new AsyncWorkScope();
  private readonly scopes = new Set([this.work]);
  private owners = 0;
  private closing = false;

  constructor(private readonly afterDrain?: () => void) {}

  get scope(): AsyncWorkScope {
    return this.work;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  get hasOwners(): boolean {
    return this.owners > 0;
  }

  reopen(): void {
    this.work = new AsyncWorkScope();
    this.scopes.add(this.work);
    this.closing = false;
  }

  private drainScope(scope: AsyncWorkScope): Promise<void> {
    return AsyncWorkScope.runWhenAllIdle(
      () => [scope],
      async () => {
        await scope.drain();
        this.afterDrain?.();
        this.scopes.delete(scope);
      },
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.scopes].map((scope) => this.drainScope(scope)));
  }

  retain() {
    if (this.closing) {
      this.reopen();
    }
    this.owners += 1;
    let released = false;
    let pending: Promise<void> | undefined;
    const beginClose = () => {
      if (released) {
        return;
      }
      released = true;
      if (--this.owners === 0) {
        this.closing = true;
        pending = this.drainScope(this.work);
        // A close prelude can precede the caller awaiting its drain.
        void pending.catch(() => {});
      }
    };
    return {
      beginClose,
      drain: () => {
        beginClose();
        return pending ?? Promise.resolve();
      },
    };
  }
}
