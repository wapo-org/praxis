export class Cancelled extends Error {}

const CANCEL_POLL_MS = 50;

export async function controlled<T>(
  checkCancelled: () => Promise<void>, operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
): Promise<T> {
  await checkCancelled();
  const controller = new AbortController();
  let poll: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const interrupt = new Promise<never>((_, reject) => {
    const check = async () => {
      try {
        await checkCancelled();
      } catch (error) {
        controller.abort();
        reject(error);
        return;
      }
      if (!stopped) poll = setTimeout(() => { void check(); }, CANCEL_POLL_MS);
    };
    poll = setTimeout(() => { void check(); }, CANCEL_POLL_MS);
    deadline = setTimeout(() => {
      controller.abort();
      reject(new Error('Operation timed out'));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation(controller.signal), interrupt]);
    await checkCancelled();
    return result;
  } finally {
    stopped = true;
    clearTimeout(poll);
    clearTimeout(deadline);
    controller.abort();
  }
}

export function abortableSleep(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Cancelled());};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
