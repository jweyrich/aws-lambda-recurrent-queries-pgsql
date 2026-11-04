'use strict'

// Integration tests: require a reachable PostgreSQL.
// Run them via `npm test`, which starts one in Docker (see scripts/test.sh).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')

const db = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secret',
}

// index.js reads its configuration from the environment at load time,
// so each test loads a fresh copy with the env it needs.
function loadHandler (env) {
  const saved = { ...process.env }
  Object.assign(process.env, {
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.database,
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    DB_SSL: '',
    ...env,
  })
  try {
    delete require.cache[require.resolve('../index.js')]
    return require('../index.js').handler
  } finally {
    process.env = saved
  }
}

function invoke (handler) {
  return new Promise((resolve, reject) => {
    handler({}, {}, (err, res) => (err ? reject(err) : resolve(res)))
      .catch(reject)
  })
}

before(async () => {
  const client = new Client(db)
  await client.connect()
  await client.query(`
    DROP SCHEMA IF EXISTS handler_test CASCADE;
    CREATE SCHEMA handler_test;
    CREATE TABLE handler_test.items (id int, name text);
    INSERT INTO handler_test.items VALUES (1, 'only-in-schema');
  `)
  await client.end()
})

after(async () => {
  const client = new Client(db)
  await client.connect()
  await client.query('DROP SCHEMA IF EXISTS handler_test CASCADE')
  await client.end()
})

test('runs the default query and returns rows as JSON', async () => {
  const handler = loadHandler({ DB_QUERY: '', DB_SCHEMA: '' })
  const res = await invoke(handler)

  assert.equal(res.statusCode, 200)
  const rows = JSON.parse(res.body)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].now, 'expected a "now" column from SELECT NOW()')
})

test('runs a custom query from DB_QUERY', async () => {
  const handler = loadHandler({ DB_QUERY: 'SELECT 42 AS answer', DB_SCHEMA: '' })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ answer: 42 }])
})

test('resolves unqualified table names against DB_SCHEMA', async () => {
  const handler = loadHandler({
    DB_QUERY: 'SELECT id, name FROM items',
    DB_SCHEMA: 'handler_test',
  })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ id: 1, name: 'only-in-schema' }])
})

test('propagates query errors', async () => {
  const handler = loadHandler({ DB_QUERY: 'SELECT * FROM no_such_table', DB_SCHEMA: '' })

  await assert.rejects(invoke(handler), /no_such_table/)
})

test('rejects an unknown DB_SSL value at load time', () => {
  assert.throws(() => loadHandler({ DB_SSL: 'yes' }), /Invalid DB_SSL "yes"/)
})

// These need the SSL-enabled server and test CA set up by scripts/test.sh:
// its certificate is valid for "localhost" only, and the CA is trusted
// through NODE_EXTRA_CA_CERTS.
const sslTest = (name, fn) => test(name, {
  skip: !process.env.TEST_SSL && 'needs the SSL-enabled database from scripts/test.sh',
}, fn)

// Asks the server whether this very connection is encrypted.
const SSL_QUERY = 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'

sslTest('DB_SSL=disable connects without TLS', async () => {
  const handler = loadHandler({ DB_SSL: 'disable', DB_QUERY: SSL_QUERY })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ ssl: false }])
})

sslTest('DB_SSL=require connects with TLS', async () => {
  const handler = loadHandler({ DB_SSL: 'require', DB_QUERY: SSL_QUERY })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ ssl: true }])
})

sslTest('DB_SSL=require does not verify the certificate', async () => {
  // 127.0.0.1 is not in the certificate, so only verify-full would refuse it.
  const handler = loadHandler({
    DB_SSL: 'require', DB_HOST: '127.0.0.1', DB_QUERY: SSL_QUERY,
  })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ ssl: true }])
})

sslTest('DB_SSL=verify-full connects when the certificate matches', async () => {
  const handler = loadHandler({ DB_SSL: 'verify-full', DB_QUERY: SSL_QUERY })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ ssl: true }])
})

sslTest('DB_SSL=verify-full refuses a certificate for another host', async () => {
  const handler = loadHandler({
    DB_SSL: 'verify-full', DB_HOST: '127.0.0.1', DB_QUERY: SSL_QUERY,
  })

  await assert.rejects(invoke(handler), /does not match certificate/)
})
