// Server-Sent Events hub: pushes chat messages, order updates and
// notifications to connected browsers without any external service.
const clients = new Map(); // userId -> Set<ServerResponse>

export function subscribe(userId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  set.add(res);
  req.on('close', () => {
    set.delete(res);
    if (set.size === 0) clients.delete(userId);
  });
}

export function push(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

export function isOnline(userId) {
  return clients.has(userId);
}

setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();
