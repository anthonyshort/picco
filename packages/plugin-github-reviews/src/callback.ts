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
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Promise.withResolvers<never>();
  timer = setTimeout(
    () => deadline.reject(new Error("Review lifecycle callback timed out")),
    CALLBACK_TIMEOUT_MS,
  );
  try {
    const delivery = callback(input);
    await Promise.race([delivery, deadline.promise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
