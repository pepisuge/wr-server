// LOG_LEVEL=debug: every packet in both directions (chat included), the internal channel and UDP relay detail - for
// protocol work. Default: connections, errors and warnings only, which is all a public server should store.
const DEBUG = process.env.LOG_LEVEL === 'debug';

module.exports = { DEBUG };
