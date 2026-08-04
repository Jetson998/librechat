import { ExecutorAdapter } from './executor-adapter.js';
import {
  PPTX_CAPABILITY_PROFILE,
  WORD_CAPABILITY_PROFILE,
  XLSX_CAPABILITY_PROFILE,
} from './constants.js';
import { OFFICE_COMPOSE_CAPABILITY_PROFILE } from './deterministic-office-compose-v1.js';

export class CodeApiOfficeExecutor extends ExecutorAdapter {
  constructor({ xlsxExecutor, wordExecutor, pptxExecutor = null, composeExecutor = null }) {
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
    this.pptxExecutor = pptxExecutor;
    this.composeExecutor = composeExecutor;
  }

  #executor(task) {
    const profile = task?.manifest?.model?.capabilityProfile;
    if (profile === WORD_CAPABILITY_PROFILE) {
      return this.wordExecutor;
    }
    if (profile === XLSX_CAPABILITY_PROFILE) {
      return this.xlsxExecutor;
    }
    if (profile === PPTX_CAPABILITY_PROFILE) {
      if (!this.pptxExecutor) {
        throw new TypeError('PPTX capability requires a pptxExecutor');
      }
      return this.pptxExecutor;
    }
    if (profile === OFFICE_COMPOSE_CAPABILITY_PROFILE) {
      if (!this.composeExecutor) {
        throw new TypeError('Office Compose capability requires a composeExecutor');
      }
      return this.composeExecutor;
    }
    throw new TypeError(`Unsupported Office capability profile: ${profile ?? 'missing'}`);
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
