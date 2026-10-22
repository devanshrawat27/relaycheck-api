// Isolate tests from local .env auth settings; suites opt in explicitly.
process.env.AUTH_REQUIRED = 'false';
process.env.API_AUTH_TOKEN = '';
