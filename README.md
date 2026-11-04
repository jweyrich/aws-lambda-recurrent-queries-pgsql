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

The function reads its settings from environment variables. When deployed, `serverless.yaml` sets them, except for the connection details, which come from an SSM parameter instead, so the password never appears in `serverless.yaml` or in the Lambda configuration. When run locally, set them in your shell.

### Connection

| Parameter field | Variable      | Default     | Description                                       |
|-----------------|---------------|-------------|---------------------------------------------------|
| `host`          | `DB_HOST`     | `localhost` | PostgreSQL host                                   |
| `port`          | `DB_PORT`     | `5432`      | PostgreSQL port                                   |
| `dbname`        | `DB_NAME`     |             | Database name                                     |
| `username`      | `DB_USER`     |             | Database user                                     |
| `password`      | `DB_PASSWORD` |             | Database password (prompted for when run locally) |

When `DB_SECRET_PARAMETER` is set, the function reads these from that SSM Parameter Store parameter each time it runs. `serverless.yaml` sets it to `/recurrent-queries/<stage>/db`, and allows the function to read only that parameter. Without it, as when run locally, they come from the variables.

The parameter holds a JSON object with the field names above, which are the ones AWS uses for database secrets. Every field is optional: any that is present takes precedence over its variable, and any that is missing falls back to it.

```json
{ "host": "mydb.xxxx.us-east-1.rds.amazonaws.com", "port": 5432, "dbname": "app", "username": "app", "password": "..." }
```

Create it, as a `SecureString`, before the first deploy:

	aws ssm put-parameter --type SecureString \
	  --name /recurrent-queries/dev/db \
	  --value file://db-credentials.json

Then delete `db-credentials.json`. Passing the JSON with `--value '{...}'` also works, but leaves the password in your shell history.

To use a Secrets Manager secret instead, such as the one RDS creates when it manages the master password, set `custom.dbSecretParameter` in `serverless.yaml` to `/aws/reference/secretsmanager/<secret name>`, and add `secretsmanager:GetSecretValue` on that secret to the IAM statements. RDS-managed secrets only hold `username` and `password`, so also add `DB_HOST` and `DB_NAME` to the `environment` in `serverless.yaml`. The function fetches the secret on every run, so it picks up rotated passwords without a redeploy.

If the parameter is encrypted with your own KMS key, rather than the default `aws/ssm` key, the function also needs `kms:Decrypt` on that key.

### Other settings

| Variable                | Default        | In `serverless.yaml`         | Description                                         |
|-------------------------|----------------|------------------------------|-----------------------------------------------------|
| `DB_SECRET_PARAMETER`   |                | `/recurrent-queries/<stage>/db` | SSM parameter with the connection details (above) |
| `DB_QUERY`              | `SELECT NOW()` | `SELECT NOW()`               | The query to run                                    |
| `DB_SCHEMA`             |                |                              | Optional schema, used as the `search_path`          |
| `DB_SSL`                | `disable`      | `verify-full`                | `disable`, `require` or `verify-full` (see below)   |
| `DB_CONNECT_TIMEOUT_MS` | `5000`         | `5000`                       | Give up connecting after this long (`0` = no limit) |
| `DB_QUERY_TIMEOUT_MS`   | `0` (no limit) | `4000`                       | Server cancels the query after this long            |

#### Timeouts

`serverless.yaml` sets `DB_QUERY_TIMEOUT_MS` to `4000`, so that connecting (up to 5 s) plus the query fits within the function's 10 s `timeout`. If you raise one, raise the other with it; otherwise Lambda kills the function before the database's error comes back.

#### Encryption

`DB_SSL` follows PostgreSQL's `sslmode` names:

- `disable`: no encryption. The default, for local databases.
- `require`: encrypted, but the server certificate is not checked.
- `verify-full`: encrypted, and the server certificate must be signed by a trusted CA and match `DB_HOST`.

`serverless.yaml` sets `verify-full`, which Amazon RDS for PostgreSQL 15 and later needs, since it rejects unencrypted connections by default. Node.js 20 and later Lambda runtimes don't trust the RDS certificate authorities by default, so `serverless.yaml` also sets `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`, the bundle AWS provides for that. For a database outside RDS, point `NODE_EXTRA_CA_CERTS` at the CA certificate that signed its server certificate.

Also replace `profile: CHANGE_ME` in `serverless.yaml` with your AWS CLI profile.

## Run locally

Run the query once from your shell and print the resulting rows:

	DB_HOST=localhost DB_NAME=database DB_USER=user DB_QUERY="SELECT NOW()" node src/index.js

## Test

Runs the integration tests against a throwaway PostgreSQL container:

	npm test

The database has SSL enabled, with a certificate from a throwaway CA, so the `DB_SSL` modes are tested too. To test against an existing database instead, set `DB_HOST` (plus `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` as needed) before running it; the SSL tests are then skipped.

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
