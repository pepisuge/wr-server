// Keeps one server running on bare metal: restarts it when it exits, and kills + restarts it when its TCP port stops
// accepting connections for 3 checks in a row (hung event loop). Docker does the same with restart + healthcheck.
//   node tools/supervise.js auth-server.js 5330
//   node tools/supervise.js game-server.js 5340
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const [script, port] = process.argv.slice(2);
if (!script || !port) {
  console.error('usage: node tools/supervise.js <server.js> <tcp port>');
  process.exit(1);
}
const CHECK_MS = Number(process.env.WR_SUPERVISE_CHECK_MS) || 30000;
const log = (msg) => console.log(`[supervise ${script}] ${new Date().toISOString()} ${msg}`);

let child = null;
let stopping = false;
let delay = 1000;
let failures = 0;

function start() {
  const startedAt = Date.now();
  failures = 0;
  child = spawn(process.execPath, [path.resolve(script)], { stdio: 'inherit' });
  log(`started pid ${child.pid}`);
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    // a server that ran for a while restarts at once; one that keeps crashing backs off up to a minute
    delay = Date.now() - startedAt > 60000 ? 1000 : Math.min(delay * 2, 60000);
    log(`exited (${signal || code}), restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

setInterval(() => {
  if (!child) return;
  const sock = net.connect(Number(port), '127.0.0.1');
  sock.setTimeout(5000);
  const done = (ok) => {
    sock.destroy();
    failures = ok ? 0 : failures + 1;
    if (failures >= 3 && child) {
      log(`port ${port} not answering for ${failures} checks, killing pid ${child.pid}`);
      child.kill('SIGKILL');
    }
  };
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
  sock.once('timeout', () => done(false));
}, CHECK_MS);

// Ctrl+C reaches the child too (same console); SIGTERM (systemd, kill) is forwarded for its graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    if (sig === 'SIGTERM') child.kill('SIGTERM');
  });
}

start();
