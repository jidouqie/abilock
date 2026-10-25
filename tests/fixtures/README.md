# Test fixtures

`cloud-selfsigned-cert.pem` and `cloud-selfsigned-key.pem` are a matching,
publicly distributable self-signed TLS pair for local synthetic tests. They are
not credentials for a real user, host or service. Anyone can read this test
private key; never use it outside disposable tests.

The TLS tests bind their own temporary loopback listeners and use this pair to
exercise certificate handling and rejection. They do not load user credentials
or contact a real cloud account.

The TypeScript helpers in this directory exercise bounded Store transactions
using temporary test directories, not the installed private data store.
