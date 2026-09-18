import { VERSION } from "../version.js";

const GLOBAL = `Global options
  --key <whk_…>        API key (default: $WEBHOOK_TOOLKIT_KEY, then the key saved by login)
  --base-url <url>     API origin (default: $WEBHOOK_TOOLKIT_URL or https://webhook-toolkit.com)
  --no-color           Disable colors (NO_COLOR is honoured too)
  -h, --help           Show help`;

export const MAIN_HELP = `webhook-toolkit ${VERSION}
Receive, forward, sign and verify webhooks from your terminal. https://webhook-toolkit.com

Usage
  webhook-toolkit <command> [options]        short alias: whtk

Receive
  listen                Public URL + live stream of incoming webhooks, optionally forwarded to localhost
  relay                 Real tunnel: senders get your localhost's actual response (Pass / Pro)
  requests <token>      List the requests captured by a URL
  replay <token> <id>   Re-send a captured request to a local URL
  endpoints             List the URLs of your account

Signatures
  sign <provider>       Build a validly signed webhook (headers + curl), or send it
  verify <provider>     Check a signature and explain why it fails

Account
  login                 Save an API key
  logout                Remove the saved API key
  whoami                Show the account and plan behind the key

AI agents
  mcp                   Start the MCP server on stdio (Claude Code, Cursor, VS Code, Codex…)

${GLOBAL}
  -v, --version        Print the version

Providers (sign / verify): stripe, github, shopify, slack, twilio, mailgun, svix, paddle, discord

Quick start
  npx webhook-toolkit listen --forward http://localhost:3000/webhooks

Run "webhook-toolkit <command> --help" for details.`;

export const COMMAND_HELP: Record<string, string> = {
  listen: `Usage: webhook-toolkit listen [options]

Get a public webhook URL and watch requests arrive live. With --forward, every request
is re-sent from your machine to a local URL (same method, headers and body), smee.io style.
The sender receives the capture URL's configured response, not your app's: use \`relay\`
when the sender must see your app's real response.

Options
  -f, --forward <url>  Re-send each request to this URL (a port like 3000 works too).
                       The captured sub-path and query are appended: /r/<token>/stripe
                       → http://localhost:3000/webhooks/stripe
  -t, --token <token>  Listen on an existing URL instead of the last one
  --new                Create a fresh URL instead of reusing the last one
  --name <name>        Name of the URL when one is created
  --body               Print each request body
  --json               Print one JSON object per line (NDJSON), for scripts

Anonymous URLs expire after 7 days. Run \`webhook-toolkit login\` to get a permanent one.

${GLOBAL}

Examples
  webhook-toolkit listen
  webhook-toolkit listen --forward http://localhost:3000/api/webhooks/stripe
  webhook-toolkit listen -f 8080 --json | jq .request.event`,

  relay: `Usage: webhook-toolkit relay --to <url|port> [--token <relay token>]

Open a real tunnel: requests sent to your relay URL are proxied to your machine and
the caller receives your local response (status, headers, body). Paid feature
(Pass or Pro): https://webhook-toolkit.com/pricing

Options
  --to <url|port>      Local target, e.g. 3000 or http://localhost:3000/webhooks (required)
  --token <token>      Relay token (default: $WEBHOOK_TOOLKIT_RELAY_TOKEN, else the first
                       relay of the account behind --key / the saved key)
  --json               Print one JSON object per line (NDJSON)

${GLOBAL}

Examples
  webhook-toolkit relay --to 3000
  webhook-toolkit relay --to http://localhost:8000/webhooks --token rly_…`,

  requests: `Usage: webhook-toolkit requests <token> [options]

List the requests captured by a URL, newest first.

Options
  -n, --limit <n>      How many (1-200, default 20)
  --after <iso date>   Only requests newer than this
  --json               Print the raw JSON array

${GLOBAL}

Example
  webhook-toolkit requests 7ETMyMMafpdj --limit 5`,

  replay: `Usage: webhook-toolkit replay <token> <requestId> --to <url|port>

Fetch a captured request and re-send it from your machine (localhost works): same
method, headers and body. Timestamped signatures (Stripe, Slack, Svix, Paddle) are replayed
as captured, so strict handlers reject them after 5 minutes: use \`sign --send\` for a
freshly signed copy.

Options
  --to <url|port>      Target, e.g. http://localhost:3000/webhooks (required)
  --json               Print the result as JSON

${GLOBAL}

Example
  webhook-toolkit replay 7ETMyMMafpdj cm1abc234 --to 3000`,

  endpoints: `Usage: webhook-toolkit endpoints [--json]

List the webhook URLs of your account (needs an API key: webhook-toolkit login).

${GLOBAL}`,

  sign: `Usage: webhook-toolkit sign <provider> --secret <secret> [payload] [options]

Build a webhook with a valid signature, byte-for-byte what the provider sends, then print
the headers and a ready-to-run curl command, or send it with --send.

Providers: stripe, github, shopify, slack, twilio, mailgun, svix (Clerk, Resend,
Standard Webhooks), paddle, discord (test key pair)

Payload (sent verbatim)
  -d, --payload <json> Inline body
  --file <path>        Body read from a file ("-" reads stdin)
  (none)               A realistic sample event (see --event)

Options
  -s, --secret <s>     Signing secret (required)
  -e, --event <type>   Event type: X-GitHub-Event / X-Shopify-Topic, or picks the sample
                       (e.g. checkout.session.completed)
  --send <url|port>    POST it now and print the response
  --url <url>          Twilio: the public URL Twilio calls (default: --send)
  --timestamp <unix>   Signature timestamp (default: now)
  --id <id>            Delivery id (svix-id, X-GitHub-Delivery, Mailgun token)
  --json               Print { headers, body, curl } as JSON

${GLOBAL}

Examples
  webhook-toolkit sign stripe --secret whsec_123 --event checkout.session.completed
  webhook-toolkit sign github --secret s3cret --file push.json --send 3000
  webhook-toolkit sign twilio --secret <auth token> --url https://example.com/sms`,

  verify: `Usage: webhook-toolkit verify <provider> --secret <secret> [body] -H "Name: value"...

Check a webhook signature. When it fails, say why: wrong secret, body modified (trailing
newline, CRLF, re-serialised JSON), whitespace in the secret, expired timestamp, or for
Twilio the URL form (http vs https, port, query, trailing slash).

Body (exact bytes matter)
  --body-file <path>   Raw body read from a file ("-" reads stdin)
  --body <string>      Raw body inline

Options
  -s, --secret <s>     Signing secret (Discord: the application public key)
  -H, --header <h>     Request header "Name: value" (repeatable)
  --url <url>          Twilio: the public URL Twilio called
  --tolerance <sec>    Timestamp tolerance, default 300 (0 disables the check)
  --json               Print the result as JSON

${GLOBAL}

Exit code: 0 valid, 1 invalid.

Example
  webhook-toolkit verify stripe --secret whsec_123 --body-file body.json \\
    -H "Stripe-Signature: t=1726000000,v1=5257a869…"`,

  login: `Usage: webhook-toolkit login [--key whk_…]

Save an API key to ~/.config/webhook-toolkit/config.json (mode 600) after checking it.
Without --key you are prompted for it. Create a key in your dashboard:
https://webhook-toolkit.com/dashboard

${GLOBAL}`,

  logout: `Usage: webhook-toolkit logout

Remove the saved API key.`,

  whoami: `Usage: webhook-toolkit whoami [--json]

Show the account, plan and limits behind the API key.

${GLOBAL}`,

  mcp: `Usage: webhook-toolkit mcp

Start the Model Context Protocol server on stdio. Point your AI agent at it:

  Claude Code   claude mcp add webhook-toolkit -- npx -y webhook-toolkit mcp
  Other clients { "command": "npx", "args": ["-y", "webhook-toolkit", "mcp"] }

WEBHOOK_TOOLKIT_KEY is optional: everything but listing URLs and AI explanations works
anonymously. Remote (no install): https://webhook-toolkit.com/mcp

${GLOBAL}`,
};
