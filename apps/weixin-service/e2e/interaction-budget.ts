export async function withinInteractionBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
  hasNewProgress?: () => boolean,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const fail = (error: unknown) => { controller.abort(error); reject(error); };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (hasNewProgress?.()) refresh();
          else fail(new Error(`interaction idle for ${timeoutMs} ms`));
        } catch (error) { fail(error); }
      }, timeoutMs);
    };
    refresh();
    if (hasNewProgress) poll = setInterval(() => {
      try { if (hasNewProgress()) refresh(); }
      catch (error) { fail(error); }
    }, 100);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); clearInterval(poll); }
}
