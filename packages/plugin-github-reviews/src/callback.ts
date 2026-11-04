/**
 * Bound application lifecycle reporting.
 */
const CALLBACK_TIMEOUT_MS = 30_000;

/**
 * A stalled notification must not retain a review worker slot indefinitely.
 */
export async function deliverCallback<Input>(
  callback: (input: Input) => void | Promise<void>,
  input: Input,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = Promise.withResolvers<never>();
  const cancellation = signal
    ? new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      })
    : undefined;
  timer = setTimeout(
    () => deadline.reject(new Error("Review lifecycle callback timed out")),
    CALLBACK_TIMEOUT_MS,
  );
  try {
    const delivery = callback(input);
    await Promise.race(
      cancellation ? [delivery, deadline.promise, cancellation] : [delivery, deadline.promise],
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}
