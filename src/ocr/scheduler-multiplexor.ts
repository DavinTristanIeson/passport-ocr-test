import { type Scheduler, type InitOptions, createScheduler, createWorker, WorkerParams } from "tesseract.js";

/** Configuration for the creation of a worker. This configuration is not reactive.
 *  Even if you change ``count``, the number of workers in the scheduler will stay the same as the value of ``count`` during initialization. */
interface WorkerConfig {
  /** Number of workers to create for a scheduler. */
  count: number;
  /** Prefer speed to accuracy */
  fast?: boolean;
  /** Options passed to ``createWorker`` during the initialization of a worker */
  initOptions?: Partial<InitOptions>;
  /** Additional parameters set after worker initialization */
  params?: Partial<WorkerParams>;
}

export type SchedulerMultiplexorConfig<TKeys extends string> = Record<TKeys, WorkerConfig>;

/** Manager class for schedulers with different configurations.
 *  For example, you might want to have a Scheduler with workers that exclusively deal with numbers, and then another that deals with alphabetical characters */
export default class SchedulerMultiplexor<TKeys extends string = string> {
  private schedulers: Partial<Record<TKeys, Scheduler>>;
  private configs: Record<TKeys, WorkerConfig>;
  constructor(configs: SchedulerMultiplexorConfig<TKeys>) {
    this.schedulers = {};
    this.configs = configs;
    for (let key of Object.keys(configs)) {
      this.getScheduler(key as TKeys);
    }
  }
  /** Gets a scheduler based on a key. It's recommended that you use enums or literal unions for TKeys rather than string for type safety. */
  async getScheduler(key: TKeys) {
    if (this.schedulers[key]) {
      return this.schedulers[key]!;
    }
    const config = this.configs[key];
    const scheduler = await createScheduler();
    this.schedulers[key] = scheduler;

    const langPath = config.fast ? "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main" : undefined;
    await Promise.all(Array.from({ length: config.count }, async (_, i) => {
      const worker = await createWorker("ind", undefined, {
        langPath,
        cachePath: config.fast ? 'fast' : 'regular',
        gzip: !config.fast,
      }, config.initOptions);
      if (config.params) {
        await worker.setParameters(config.params);
      }
      scheduler.addWorker(worker);
    }));

    return scheduler;
  }
  /** Terminates all existing schedulers */
  async terminate() {
    await Promise.all(Object.keys(this.schedulers).map(key => {
      const scheduler = this.schedulers[key as TKeys];
      return scheduler?.terminate();
    }));
  }
}
