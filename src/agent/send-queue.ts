export function appendSequentialTask(
  previous: Promise<void>,
  task: () => Promise<void>,
  onPreviousError: (error: unknown) => void,
): Promise<void> {
  return previous
    .catch((error) => {
      try {
        onPreviousError(error);
      } catch {
        // Delivery must not depend on optional logging/bookkeeping.
      }
    })
    .then(task);
}
