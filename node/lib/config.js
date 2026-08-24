const config = require('../config.json');

// Bare metal (no env vars set) leaves every `if` false, so `config` stays
// byte-identical to a plain require('./config.json') - the container path
// (docker-compose.yml) is the only caller that ever sets these.
function overlay(db) {
  if (process.env.DB_HOST) db.host = process.env.DB_HOST;
  if (process.env.DB_USER) db.user = process.env.DB_USER;
  if (process.env.DB_PASSWORD !== undefined) db.password = process.env.DB_PASSWORD;
}

overlay(config.auth.db);
overlay(config.game.db);
if (process.env.GAME_AUTH_HOST) config.game.authServerIp = process.env.GAME_AUTH_HOST;

module.exports = config;
