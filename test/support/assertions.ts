/**
 * Awaits a promise that must reject and returns the rejection for assertions. A typed alternative to
 * `expect(promise).rejects`, whose matchers bun-types declares as returning void.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}
