# Cloudflare Workers backend

The backend exposes a public text **Responses API** and uses `fetch` to call either
a Responses provider or an OpenAI-compatible Chat Completions provider.
`AI_PROTOCOL` is set to `chat_completions` in `wrangler.jsonc` for the current GLM deployment. UniAI, Fastify,
PM2 and local file logging are no longer needed. The profile site in `docs/` is
unchanged and can remain on its current host. The backend root still renders the
repository README; Markdown content is bundled at build time.

## Provider configuration

Use Node.js 22 or later and Yarn 1:

```sh
yarn install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your provider's URL, key and model.
yarn dev
```

| Setting                  | Meaning                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_BASE_URL` | HTTPS API base including its version/path, or a complete endpoint matching AI_PROTOCOL. Chat mode appends `/chat/completions`; Responses mode appends `/responses`. |
| `AI_API_KEY`           | Provider key, sent upstream as`Authorization: Bearer …`. Never put this in frontend code.                                                                                                                                 |
| `AI_MODEL`             | Exact model identifier supported by your provider.                                                                                                                                                                           |
| `MAX_HISTORY_MESSAGES` | Latest messages retained, including the current question; default`12`. Set `0` to disable trimming. Leading orphan assistant messages are removed after trimming. Older context will be forgotten.                       |
| `MAX_INPUT_CHARS`      | Maximum retained user/assistant text length, default`24000` characters. Oversized input is rejected, not silently shortened. This is a character bound, not a token count; the server's resume/prompt is additional input. |
| `MAX_OUTPUT_TOKENS`    | Server output ceiling, default`1024`. Includes reasoning tokens when the model counts them toward this limit. Raise it for reasoning-heavy models.                                                                         |

`AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are required. Local secrets belong in
`.dev.vars`, which is ignored by Git. Limits live in `wrangler.jsonc` and may also
be overridden locally in `.dev.vars`.

**GLM/Qwen compatibility:** use `AI_PROTOCOL=chat_completions` for providers that
support `/chat/completions`, or `AI_PROTOCOL=responses` for native `/responses`.
Set this in `wrangler.jsonc` (local override in `.dev.vars`). The chosen endpoint
is appended to the base URL; a complete matching endpoint is also accepted.
There is no automatic protocol fallback or billable retry. Frontend requests
remain Responses format in either mode.

Current GLM settings: `AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`,
`AI_MODEL=glm-4-flash`, and your existing `AI_API_KEY`. Model availability must
be verified against your account; the adapter does not silently substitute models.
Do not change AI_BASE_URL to the Worker's own URL or `api.devil.ren`.

Chat mode converts `instructions` to a system message, `input` to `messages`,
and `max_output_tokens` to `max_tokens`. It converts text, usage and SSE events
back into Responses format. Reasoning-only deltas are not exposed. Length and
content-filter stops become `response.incomplete`; malformed/interrupted streams
become `response.failed`. Tools and other non-text outputs are unsupported.

## Deploy without a server

```sh
yarn build                  # Local bundle validation; does not deploy
yarn wrangler login
# Enter each value at the interactive prompt; do not put real keys in commands.
yarn wrangler secret put AI_BASE_URL
yarn wrangler secret put AI_API_KEY
yarn wrangler secret put AI_MODEL
yarn deploy
```

The first secret command may ask to create the Worker named in `wrangler.jsonc`.
After deployment, use the returned Worker URL, or attach a custom domain in the
Cloudflare dashboard. This repository does not provision a Cloudflare account,
configure a domain, or deploy automatically.

The endpoint is intentionally public and allows cross-origin calls without client
authentication. The provider key stays in Cloudflare Secrets and is injected only
into outbound requests. Anyone can consume the configured provider quota via this
endpoint; no frontend key is required. Do not send the provider key to browsers.

## Bind api.devil.ren after verifying the deployment

Ensure `devil.ren` is an active zone in the same Cloudflare account. In the Worker
`devilyouwei-api`, open Settings > Domains & Routes > Add > Custom Domain (or the
Domains tab), enter `api.devil.ren`, and confirm. Cloudflare manages DNS and TLS.
If an existing record for `api` conflicts, check its current use before replacing
it. Do not change the records for the main website or `chat` subdomain.

Once active, use `https://api.devil.ren/v1/responses` in the frontend. No provider
URL or provider key belongs in the frontend. Keep AI_BASE_URL pointing to GLM.
The custom domain is deliberately not enabled in the local deployment config yet,
so you can test workers.dev first. After binding it in the dashboard, add
`"routes": [{ "pattern": "api.devil.ren", "custom_domain": true }]` and
`"workers_dev": true` to `wrangler.jsonc` to preserve both addresses in subsequent
deployments. See [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Troubleshooting

`yarn wrangler tail` shows safe transport categories (`dns_error`, `tls_error`,
`request_aborted`, `connection_error`), never raw exception messages, keys or chat
input. Redirects are refused with an explicit error; configure the final provider
endpoint instead. Invalid key header characters are detected before fetching.
Provider HTTP errors report `upstream_status`. Protocol adaptation does not by
itself prove that a Cloudflare-to-provider connectivity issue is fixed.

## API and frontend migration

`POST /responses` and `POST /v1/responses` use the same handler. `/chat` is an alias
for the new protocol, **not** the old UniAI response format. `GET /chat` is no longer
supported. The external chat frontend is not part of this repository and needs to
be updated separately.

```sh
curl http://localhost:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"请介绍一下你的研究方向", "stream":false, "max_output_tokens":512}'
```

For multiple turns, supply text messages:

```json
{
  "input": [
    { "role": "user", "content": "What do you work on?" },
    { "role": "assistant", "content": "I work on AI and robotics." },
    { "role": "user", "content": "Tell me more about robotics." }
  ],
  "stream": true
}
```

Supported request fields: `input`, `stream`, `max_output_tokens`, `temperature`,
`top_p`, and optional `model` (must match `AI_MODEL`). `input` accepts a string or
user/assistant messages with string content or `input_text`/`output_text` text
parts. It must end with a user message. Sampling parameters are only sent when
explicitly supplied because provider/model support varies. The server injects its
resume-based `instructions` once per request and sends `store: false` in native Responses mode.
This is a text-chat subset of Responses, not a complete API gateway: tools,
multimodal input, caller instructions, `previous_response_id`, and other fields
are rejected explicitly. Chat Completions' `messages`/`max_tokens` and the old
UniAI `top`/`maxLength` fields are not supported.

For a non-streaming response, read text from `output`:

```js
const text = response.output
    .filter(item => item.type === 'message')
    .flatMap(item => item.content)
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('')
```

For streaming, parse standard SSE events, not network chunks. Append `delta` from
`response.output_text.delta`; finish on `response.completed`; handle
`response.failed`, `response.incomplete`, and `error`. SSE frames can span multiple
chunks and UTF-8 characters can be split across chunks. Use an SSE parser with an
incremental text decoder. Do not wait for the Chat Completions `[DONE]` sentinel.
Native Responses events pass through unchanged. Chat Completions events and usage
are converted to Responses equivalents; usage is null if the provider omits it.
The old `{status,msg,data}` wrapper has been removed.

Validation/configuration failures use non-2xx HTTP status and
`{"error":{"message":"…","type":"…","code":null}}`. Provider HTTP failures
return `502` (`429` remains `429`) with `upstream_status`; their diagnostic bodies
are not exposed. Stream failures after headers are sent remain stream events or
transport errors and must be handled by the client.

## Token usage

Switching protocols does **not** automatically reduce billed tokens. This backend
bounds history and output, and returns the provider's original usage data. The
resume and system prompt still contribute input tokens on every request. To reduce
that cost further, edit `docs/system-prompt.md` or use a shorter factual resume;
this migration preserves the existing profile content. Provider prompt caching
and its billing are provider-specific. `store: false` is a storage choice, not a
cost-saving mechanism.

OpenAI also documents that earlier context is still billed when using
`previous_response_id`: [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state).
See [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
for event handling.

## Checks

```sh
yarn test
yarn lint
yarn build
```

Tests use a fake provider; they spend no API tokens. Real GLM/Qwen/gateway
compatibility requires your configured endpoint, model and key and a live smoke
test. No real provider keys are included in this repository.
