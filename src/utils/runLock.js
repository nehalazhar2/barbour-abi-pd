// One lock for every pass that writes leads: the daily run, the weekly catch-up
// and the A4 overnight re-process. Plain in-process flag — the worker is a single
// Node process. Holders are named so a log can say who has it, and so one pass
// can never release another's hold.
export function createRunLock() {
  let owner = null;
  return {
    tryAcquire(name) {
      if (owner) return false;
      owner = name;
      return true;
    },
    release(name) {
      if (owner === name) owner = null;
    },
    holder: () => owner,
  };
}

export const runLock = createRunLock();
