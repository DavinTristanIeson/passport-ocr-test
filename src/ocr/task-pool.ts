export enum TaskResultStatus {
  Complete = "complete",
  Ignore = "ignore",
  Error = "error",
  ShortCircuit = "short-circuit",
}

type TaskResult<T> = {
  type: TaskResultStatus.Complete | TaskResultStatus.ShortCircuit;
  value: T;
} | {
  type: TaskResultStatus.Ignore;
} | {
  type: TaskResultStatus.Error;
  error: any;
}
type Task<T> = (i: number) => Promise<TaskResult<T>>;
type RequiredKeys<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
type TaskPoolTaskTracker = {
  /** Global un */
  index: number;
  target: number;
  shortCircuit: boolean;
}

export interface TaskPoolOptions {
  /** The number of tasks that need to be executed */
  count: number;
  /** The number of tasks that can be executed at the same time */
  limit: number;
}

/** Utility class for performing tasks with a limit to the number of tasks that can execute at the same time. */
export default class TaskPool<T> {
  /** A function that takes in the current index. This is more ergonomic compared to storing an array of anonymous callbacks */
  task: Task<T>;
  options: TaskPoolOptions;
  constructor(task: Task<T>, options: RequiredKeys<Partial<TaskPoolOptions>, "count">) {
    this.task = task;
    this.options = {
      count: options.count,
      limit: options?.limit ?? 4,
    }
  }

  private async runInner(tracker: TaskPoolTaskTracker, store: (value: T, index: number) => void) {
    // Abandon task if the short circuit flag has been raised, or index has reached target
    if (tracker.shortCircuit || tracker.index === tracker.target) {
      return;
    }
    // Claim the current index and increment it for other tasks
    const index = tracker.index++;
    const result = await this.task(index);
    if (tracker.shortCircuit) {
      return;
    }
    switch (result.type) {
      case TaskResultStatus.Complete:
        store(result.value, index);
        break;
      case TaskResultStatus.Ignore:
        break;
      case TaskResultStatus.Error:
        throw result.error;
      case TaskResultStatus.ShortCircuit:
        store(result.value, index);
        tracker.shortCircuit = true;
        return;
    }
    // yes, this is a recursive function; consider using ``options.count`` less than 1000 to avoid stack overflow.
    // The primary use case for this is for expensive operations that cannot be too parallelized.
    await this.runInner(tracker, store);
  }

  /** Gets all values from tasks that didn't return ``TaskResultStatus.Ignore``. If any error occurs for any of the task, this rejects with said error. */
  async run(): Promise<T[]> {
    const results = Array<T>(this.options.count);
    // Tracker needs to be an object so the properties are shared between ``runInner`` invocations.
    const tracker: TaskPoolTaskTracker = {
      index: 0,
      target: this.options.count,
      shortCircuit: false,
    };
    await new Promise<void>((resolve, reject) => {
      let finished = 0;
      for (let i = 0; i < this.options.limit; i++) {
        this.runInner(tracker, (value, index) => {
          results[index] = value;
        }).then(() => {
          // End as soon as short circuit is raised
          if (tracker.shortCircuit) {
            resolve();
          }
          finished++;
          // Otherwise, wait until all tasks are finished
          if (finished === this.options.limit) {
            resolve();
          }
        }).catch(reject);
      }
    });
    return results.filter(x => x !== undefined);
  }

  /** Gets the latest value from all tasks.
   * 
   *  This will always resolve with the short-circuited value if a short circuit happens,
   *  or the latest value that is not short-circuited if there's none. */
  async latest(): Promise<T | null> {
    let result: T | null = null;
    const tracker: TaskPoolTaskTracker = {
      index: 0,
      target: this.options.count,
      shortCircuit: false,
    };
    await new Promise<void>((resolve, reject) => {
      let finished = 0;
      for (let i = 0; i < this.options.limit; i++) {
        this.runInner(tracker, (value, index) => {
          result = value;
        }).then(() => {
          // End as soon as short circuit is raised
          if (tracker.shortCircuit) {
            resolve();
          }
          finished++;
          // Otherwise, wait until all tasks are finished
          if (finished === this.options.limit) {
            resolve();
          }
        }).catch(reject);
      }
    });
    return result;
  }
}