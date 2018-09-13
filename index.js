'use strict'

/*
  Example to run it from shell:

  DB_HOST="localhost" \
  DB_PORT=5432 \
  DB_NAME="database" \
  DB_SCHEMA="current" \
  DB_USER="user" \
  DB_PASSWORD="password"
  DB_QUERY="SELECT NOW()" \
  node index.js
*/

const { Client } = require('pg')
const util = require('util')

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
  })

  await client.connect()

  // Workaround because node-postgres==7.4.3
  // doesn't support configuring the DB schema.
  // REF: https://github.com/brianc/node-postgres/issues/1123
  if (config.db_schema) {
    query_string = util.format(
      "SET SCHEMA '%s'; %s",
      config.db_schema,
      query_string)
  }

  const result = await client.query(query_string)
  await client.end()
  return result.rows
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

if (process.env.SHELL) {
  exports.interactive_handler()
}