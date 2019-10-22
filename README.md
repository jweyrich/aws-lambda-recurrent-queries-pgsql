
## Pre-requisites

1. Node.js v10.x or later.
1. Serverless CLI v1.9.0 or later. You can run npm `install -g serverless` to install it.
1. An AWS account. If you don't already have one, you can sign up for a free trial that includes 1 million free Lambda requests per month.
1. Set-up your [Provider Credentials](https://serverless.com/framework/docs/providers/aws/guide/credentials).

## Deploy, test and diagnose your service

1. Deploy the Service

Use this when you have made changes to your Functions, Events or Resources in serverless.yml or you simply want to deploy all changes within your Service at the same time.

	serverless deploy -v

2. Deploy the Function

Use this to quickly upload and overwrite your function code, allowing you to develop faster.

	serverless deploy function -f hello

3. Invoke the Function

Invokes a Function and returns logs.

	serverless invoke -f hello -l

4. Fetch the Function Logs

Open up a separate tab in your console, set your Provider Credentials and stream all logs for a specific Function using this command.

	serverless logs -f hello -t

## Cleanup

If at any point, you no longer need your service, you can run the following command to remove the Functions, Events and Resources that were created, and ensure that you don't incur any unexpected charges.

	serverless remove
