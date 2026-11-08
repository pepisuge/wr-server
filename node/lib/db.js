const mysql = require('mysql2/promise');

// Most writes are fire-and-forget (db.query(...).catch(log)), and mysql2's pool.end() fails anything still queued
// ("Pool is closed"). So the pool counts its in-flight queries, and close() waits for them (and any they trigger)
// before ending the pool: a shutdown then loses no write.
function createPool(dbConfig) {
  const pool = mysql.createPool(dbConfig);
  const inFlight = new Set();
  const query = pool.query.bind(pool);
  pool.query = (...args) => {
    const p = query(...args);
    inFlight.add(p);
    p.then(
      () => inFlight.delete(p),
      () => inFlight.delete(p)
    );
    return p;
  };
  pool.close = async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    await pool.end();
  };
  return pool;
}

// SIGINT (Ctrl+C) / SIGTERM (docker stop): run `stop`, then exit. Forced exit after 10 s if something hangs.
// Windows: only Ctrl+C in the server's own console sends SIGINT; taskkill / Stop-Process kill without it.
function onShutdown(label, stop) {
  let stopping = false;
  const handler = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${label}: ${signal}, shutting down`);
    setTimeout(() => process.exit(1), 10000).unref();
    try {
      await stop();
      console.log(`${label}: stopped cleanly`);
      process.exit(0);
    } catch (err) {
      console.error(`${label}: shutdown failed:`, err.message);
      process.exit(1);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

module.exports = { createPool, onShutdown };
