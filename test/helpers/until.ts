/** Polls `cond` until it is truthy; throws after `timeoutMs` so a broken test fails instead of hanging. */
export async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A local URL where nothing listens (a port just released by the OS), for "connection refused" cases. */
export async function deadUrl(): Promise<string> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
