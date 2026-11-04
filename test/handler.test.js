'use strict'

// Integration tests: require a reachable PostgreSQL.
// Run them via `npm test`, which starts one in Docker (see scripts/test.sh).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
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

// Calls the handler as Lambda does for an async handler: with an event and
// a context, and no callback, so it must return (or throw) the result.
function invoke (handler) {
  return handler({}, {})
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

test('rejects invalid timeout values at load time', () => {
  assert.throws(
    () => loadHandler({ DB_CONNECT_TIMEOUT_MS: '5s' }),
    /Invalid DB_CONNECT_TIMEOUT_MS "5s"/)
  assert.throws(
    () => loadHandler({ DB_QUERY_TIMEOUT_MS: '-1' }),
    /Invalid DB_QUERY_TIMEOUT_MS "-1"/)
})

test('gives up connecting after DB_CONNECT_TIMEOUT_MS', async () => {
  // A server that accepts TCP connections but never answers, like a
  // firewalled or overloaded database.
  const sockets = new Set()
  const server = net.createServer((socket) => sockets.add(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const handler = loadHandler({
      DB_HOST: '127.0.0.1',
      DB_PORT: String(server.address().port),
      DB_CONNECT_TIMEOUT_MS: '200',
    })
    const started = Date.now()

    await assert.rejects(invoke(handler), /timeout/i)
    assert.ok(Date.now() - started < 2000, 'should fail soon after the timeout')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('sets no query time limit by default', async () => {
  const handler = loadHandler({ DB_QUERY: 'SHOW statement_timeout' })
  const res = await invoke(handler)

  assert.deepEqual(JSON.parse(res.body), [{ statement_timeout: '0' }])
})

test('cancels a query that runs longer than DB_QUERY_TIMEOUT_MS', async () => {
  const handler = loadHandler({
    DB_QUERY: 'SELECT pg_sleep(5)',
    DB_QUERY_TIMEOUT_MS: '200',
  })
  const started = Date.now()

  await assert.rejects(invoke(handler), /statement timeout/)
  assert.ok(Date.now() - started < 2000, 'should fail soon after the timeout')
})

// --- Credentials from an SSM parameter --------------------------------------

// A minimal stand-in for the SSM API, serving GetParameter from `parameters`.
// The real AWS SDK is pointed at it through AWS_ENDPOINT_URL_SSM.
async function fakeSsm (parameters) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body)
      requests.push({ target: req.headers['x-amz-target'], ...input })
      res.setHeader('content-type', 'application/x-amz-json-1.1')
      if (input.Name in parameters) {
        res.end(JSON.stringify({
          Parameter: { Name: input.Name, Type: 'SecureString', Value: parameters[input.Name] },
        }))
      } else {
        res.statusCode = 400
        res.end(JSON.stringify({ __type: 'ParameterNotFound', message: '' }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Runs `fn` with AWS SDK settings that reach the fake SSM and nothing else.
async function withSsm (parameters, fn) {
  const ssm = await fakeSsm(parameters)
  const saved = { ...process.env }
  Object.assign(process.env, {
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_ENDPOINT_URL_SSM: ssm.endpoint,
    AWS_EC2_METADATA_DISABLED: 'true',
  })
  try {
    return await fn(ssm)
  } finally {
    process.env = saved
    await ssm.close()
  }
}

const WHO_AM_I = 'SELECT current_user AS "user", current_database() AS database'

test('reads all credentials from DB_SECRET_PARAMETER', async () => {
  const secret = JSON.stringify({
    host: db.host, port: db.port, dbname: db.database,
    username: db.user, password: db.password,
  })
  await withSsm({ '/app/db': secret }, async (ssm) => {
    // Every DB_* value is wrong, so this only works if the secret is used.
    const handler = loadHandler({
      DB_SECRET_PARAMETER: '/app/db',
      DB_HOST: 'invalid.invalid', DB_PORT: '1', DB_NAME: 'wrong',
      DB_USER: 'wrong', DB_PASSWORD: 'wrong',
      DB_QUERY: WHO_AM_I,
    })
    const res = await invoke(handler)

    assert.deepEqual(JSON.parse(res.body), [{ user: db.user, database: db.database }])
    assert.deepEqual(ssm.requests, [{
      target: 'AmazonSSM.GetParameter', Name: '/app/db', WithDecryption: true,
    }])
  })
})

test('falls back to DB_* variables for fields the secret lacks', async () => {
  // Like an RDS-managed secret, which only holds the username and password.
  const secret = JSON.stringify({ username: db.user, password: db.password })
  await withSsm({ '/app/db': secret }, async () => {
    const handler = loadHandler({
      DB_SECRET_PARAMETER: '/app/db',
      DB_USER: 'wrong', DB_PASSWORD: 'wrong',
      DB_QUERY: WHO_AM_I,
    })
    const res = await invoke(handler)

    assert.deepEqual(JSON.parse(res.body), [{ user: db.user, database: db.database }])
  })
})

test('prefers the secret over DB_* variables', async () => {
  const secret = JSON.stringify({ password: 'not-the-password' })
  await withSsm({ '/app/db': secret }, async () => {
    // DB_PASSWORD is correct, but the secret's value must win.
    const handler = loadHandler({ DB_SECRET_PARAMETER: '/app/db' })

    await assert.rejects(invoke(handler), /password authentication failed/)
  })
})

test('reports a parameter that is not JSON, without its value', async () => {
  await withSsm({ '/app/db': 'hunter2' }, async () => {
    const handler = loadHandler({ DB_SECRET_PARAMETER: '/app/db' })

    await assert.rejects(invoke(handler), (err) => {
      assert.match(err.message, /SSM parameter "\/app\/db" is not valid JSON/)
      assert.doesNotMatch(err.message, /hunter2/)
      return true
    })
  })
})

test('reports a parameter that is JSON but not an object', async () => {
  await withSsm({ '/app/db': '["a", "b"]' }, async () => {
    const handler = loadHandler({ DB_SECRET_PARAMETER: '/app/db' })

    await assert.rejects(invoke(handler), /must contain a JSON object/)
  })
})

test('reports a missing parameter', async () => {
  await withSsm({}, async () => {
    const handler = loadHandler({ DB_SECRET_PARAMETER: '/app/missing' })

    await assert.rejects(invoke(handler), { name: 'ParameterNotFound' })
  })
})
