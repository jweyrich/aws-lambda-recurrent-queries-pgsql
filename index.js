'use strict'

/*
  Example to run it from shell:

  DB_HOST="localhost" \
  DB_PORT=5432 \
  DB_NAME="database" \
  DB_SCHEMA="current" \
  DB_USER="user" \
  DB_PASSWORD="password" \
  DB_SSL="disable" \
  DB_QUERY="SELECT NOW()" \
  node index.js
*/

const { Client } = require('pg')

// DB_SSL mirrors libpq's sslmode names:
//   disable     - no TLS (default)
//   require     - TLS, but the server certificate is not verified
//   verify-full - TLS, verifying the certificate chain and hostname
//                 (trusted CAs come from Node's store plus NODE_EXTRA_CA_CERTS)
function ssl_options (mode = 'disable') {
  switch (mode) {
    case 'disable':
      return false
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      throw new Error(
        `Invalid DB_SSL "${mode}": expected disable, require or verify-full`)
  }
}

// Parses a timeout in milliseconds; 0 means no limit.
function timeout_ms (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(
      `Invalid ${name} "${raw}": expected a whole number of milliseconds (0 = no limit)`)
  }
  return ms
}

const config = {
  endpoint: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
  },
  auth: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  db_name: process.env.DB_NAME,
  db_schema: process.env.DB_SCHEMA,
  ssl: ssl_options(process.env.DB_SSL || undefined),
  // Without a limit, pg waits forever for an unreachable server.
  connect_timeout_ms: timeout_ms('DB_CONNECT_TIMEOUT_MS', 5000),
  // Enforced by the server (statement_timeout), which also stops the work there.
  query_timeout_ms: timeout_ms('DB_QUERY_TIMEOUT_MS', 0),
  query: process.env.DB_QUERY || 'SELECT NOW()',
}

async function run_query (query_string) {
  //console.log(config)
  const client = new Client({
    host: config.endpoint.host,
    port: config.endpoint.port,
    database: config.db_name,
    user: config.auth.user,
    password: config.auth.password,
    ssl: config.ssl,
    connectionTimeoutMillis: config.connect_timeout_ms,
    statement_timeout: config.query_timeout_ms || undefined,
    // Set the schema via the search_path startup parameter.
    // REF: https://github.com/brianc/node-postgres/issues/1123
    options: config.db_schema
      ? `-c search_path=${config.db_schema}`
      : undefined,
  })

  await client.connect()
  try {
    const result = await client.query(query_string)
    return result.rows
  } finally {
    // Always close, or a failed query leaks the connection
    // (and keeps the Lambda/process event loop alive).
    await client.end()
  }
}

exports.interactive_handler = async () => {
  if (!config.auth.password) {
    const prompt = require('prompt-sync')();
    config.auth.password = prompt('Password: ', {echo: ''})
  } 
  const result = await run_query(config.query)
  console.log(result)
}

exports.handler = async (event, context, callback) => {
    const result = await run_query(config.query)
    const response = {
        statusCode: 200,
        body: JSON.stringify(result)
    };
    callback(null, response)
}

// Only auto-run when executed directly (`node index.js`), not when
// loaded as a module by Lambda, `serverless invoke local`, or tests.
if (require.main === module) {
  exports.interactive_handler()
}