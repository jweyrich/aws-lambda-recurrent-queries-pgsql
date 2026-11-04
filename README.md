# aws-lambda-recurrent-queries-pgsql

An AWS Lambda function that connects to PostgreSQL, runs a query, and exits.
It is triggered on a schedule (hourly by default, see `serverless.yaml`).

## Pre-requisites

1. Node.js v20.x or later.
1. Serverless Framework v3. It is installed as a dev dependency by `npm install` (run it with `npx serverless`).
1. An AWS account. If you don't already have one, you can sign up for a free trial that includes 1 million free Lambda requests per month.
1. Set-up your [Provider Credentials](https://serverless.com/framework/docs/providers/aws/guide/credentials).
1. Docker, to run the tests.

## Configuration

The function is configured through environment variables, set in `serverless.yaml`:

| Variable      | Default        | Description                                          |
|---------------|----------------|------------------------------------------------------|
| `DB_HOST`     | `localhost`    | PostgreSQL host                                      |
| `DB_PORT`     | `5432`         | PostgreSQL port                                      |
| `DB_NAME`     |                | Database name                                        |
| `DB_USER`     |                | Database user                                        |
| `DB_PASSWORD` |                | Database password (prompted for when run locally)    |
| `DB_SCHEMA`   |                | Optional schema, used as the `search_path`           |
| `DB_QUERY`    | `SELECT NOW()` | The query to run                                     |

Also replace `profile: CHANGE_ME` in `serverless.yaml` with your AWS CLI profile.

## Run locally

Run the query once from your shell and print the resulting rows:

	DB_HOST=localhost DB_NAME=database DB_USER=user DB_QUERY="SELECT NOW()" node index.js

## Test

Runs the integration tests against a throwaway PostgreSQL container:

	npm test

To test against an existing database instead, set `DB_HOST` (plus `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` as needed) before running it.

## Deploy, invoke and diagnose

1. Deploy the service

Use this when you have changed `serverless.yaml`, or to deploy everything at once.

	npx serverless deploy --verbose

2. Deploy the function only

Use this to quickly upload and overwrite the function code.

	npx serverless deploy function -f recurrent_select_now

3. Invoke the function

Invokes the deployed function and prints its logs.

	npx serverless invoke -f recurrent_select_now -l

4. Fetch the function logs

Streams the logs of the deployed function.

	npx serverless logs -f recurrent_select_now -t

## Cleanup

To remove the function, schedule, and everything else that was created, so you don't incur any unexpected charges:

	npx serverless remove
