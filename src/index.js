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
  node src/index.js
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
  // Optional SSM parameter holding the credentials as JSON (see load_secret).
  secret_parameter: process.env.DB_SECRET_PARAMETER || undefined,
  query: process.env.DB_QUERY || 'SELECT NOW()',
}

// Reads the credentials from an SSM parameter (normally a SecureString) whose
// value is a JSON object using the field names of AWS database secrets:
//   { "host", "port", "dbname", "username", "password" }
// All fields are optional; missing ones fall back to the DB_* variables.
// A Secrets Manager secret (e.g. one managed by RDS) works too, through
// SSM's "/aws/reference/secretsmanager/<secret name>" parameter path.
//
// Fetched on every invocation rather than cached, so a rotated password is
// picked up immediately; at one run an hour, the extra call is negligible.
async function load_secret (name) {
  const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm')
  const ssm = new SSMClient({})
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }))

  // Never include the value in errors: it would end up in the logs.
  let secret
  try {
    secret = JSON.parse(Parameter.Value)
  } catch {
    throw new Error(`SSM parameter "${name}" is not valid JSON`)
  }
  if (secret === null || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error(`SSM parameter "${name}" must contain a JSON object`)
  }
  return secret
}

async function connection_settings () {
  const settings = {
    host: config.endpoint.host,
    port: config.endpoint.port,
    database: config.db_name,
    user: config.auth.user,
    password: config.auth.password,
  }
  if (!config.secret_parameter) return settings

  const secret = await load_secret(config.secret_parameter)
  return {
    host: secret.host ?? settings.host,
    port: secret.port ?? settings.port,
    database: secret.dbname ?? settings.database,
    user: secret.username ?? settings.user,
    password: secret.password ?? settings.password,
  }
}

async function run_query (query_string) {
  const client = new Client({
    ...await connection_settings(),
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
  if (!config.auth.password && !config.secret_parameter) {
    const prompt = require('prompt-sync')()
    config.auth.password = prompt('Password: ', { echo: '' })
  }
  const result = await run_query(config.query)
  console.log(result)
}

exports.handler = async () => {
  const result = await run_query(config.query)
  return {
    statusCode: 200,
    body: JSON.stringify(result),
  }
}

// Only auto-run when executed directly (`node src/index.js`), not when
// loaded as a module by Lambda, `serverless invoke local`, or tests.
if (require.main === module) {
  exports.interactive_handler()
}