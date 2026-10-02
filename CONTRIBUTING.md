# Contributing

Open an issue with a URL or a small local server that reproduces a wrong cache diagnosis. Include the request URL, response status, and relevant headers. Remove tokens, cookies, and private hostnames before sharing them.

For a code change, run `npm ci` and `npm test`. Add a fixture for the header combination that failed. The tests use local HTTP servers and do not require a remote service.

Keep output claims limited to what the response headers establish. A probe cannot read a browser's stored response or a CDN configuration.
