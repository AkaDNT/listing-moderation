const path = require('node:path');
const { Database } = require(path.resolve('dist/src/db/database.js'));
const close = Database.prototype.close;

Database.prototype.close = async function () {
  await close.call(this);
  throw new Error('t11-shutdown-private-sentinel');
};
