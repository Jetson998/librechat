import { ExecutorAdapter } from './executor-adapter.js';
import { WORD_CAPABILITY_PROFILE } from './constants.js';

export class CodeApiOfficeExecutor extends ExecutorAdapter {
  constructor({ xlsxExecutor, wordExecutor }) {
    super();
    if (!xlsxExecutor || !wordExecutor) {
      throw new TypeError('CodeApiOfficeExecutor requires XLSX and Word executors');
    }
    for (const [name, executor] of [['xlsxExecutor', xlsxExecutor], ['wordExecutor', wordExecutor]]) {
      for (const method of ['prepare', 'execute', 'verify', 'publish']) {
        if (typeof executor[method] !== 'function') {
          throw new TypeError(`${name}.${method} must be a function`);
        }
      }
    }
    this.xlsxExecutor = xlsxExecutor;
    this.wordExecutor = wordExecutor;
  }

  #executor(task) {
    return task?.manifest?.model?.capabilityProfile === WORD_CAPABILITY_PROFILE
      ? this.wordExecutor
      : this.xlsxExecutor;
  }

  prepare(args) {
    return this.#executor(args.task).prepare(args);
  }

  execute(args) {
    return this.#executor(args.task).execute(args);
  }

  verify(args) {
    return this.#executor(args.task).verify(args);
  }

  publish(args) {
    return this.#executor(args.task).publish(args);
  }
}
