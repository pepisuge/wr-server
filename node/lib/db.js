const mysql = require('mysql2/promise');

function createPool(dbConfig) {
  return mysql.createPool(dbConfig);
}

module.exports = { createPool };
