# wiretap

Raw LLM network request inspector for [oh-my-pi](https://omp.sh) (omp).

Captures every provider request the session sends — the exact JSON body that
goes on the wire — plus the paired response status, headers, and time-to-first-
byte, and renders them as an in-transcript inspector card.

```
🌐 WIRETAP                                        7 requests · 2 evicted · 4.6 MB
──────────────────────────────────────────────────────────────────────────────
#  WHEN  ENDPOINT                                          ST   TTFB    SIZE
6  1m    anthropic/claude-sonnet-4-5                      200  1.10s  192 KB
7  30s   openai/gpt-5.2-codex                             500  30.2s  393 KB
8  12s   anthropic/claude-sonnet-4-5                      200  2.41s  196 KB
9  now   anthropic/claude-sonnet-4-5                      ···      —  198 KB
```

## Install

```sh
# from the marketplace (recommended)
omp plugin marketplace add <owner>/omp-extensions
omp plugin install wiretap@omp-extensions

# or once, from a checkout
omp --extension /path/to/omp-extensions/wiretap

# or persistent: ~/.omp/agent/config.yml
extensions:
  - /path/to/omp-extensions/wiretap

# or as a linked plugin (uses the omp.extensions manifest)
cd /path/to/omp-extensions/wiretap && omp plugin link .
```

No dependencies to install at runtime — the extension imports only host-
provided `@oh-my-pi/*` modules. (`bun install` is dev-only, for typecheck
and the render preview.)

## Usage

| Command | Effect |
| --- | --- |
| `/wire` | List captured requests (chronological; newest last) |
| `/wire <n>` | Detail card: endpoint, status/ttfb, response headers, syntax-highlighted JSON body |
| `/wire dump <n> [path]` | Export a body to a file (default `wiretap-<n>.json` in cwd) |
| `/wire clear` | Empty the capture buffer |
| `/wire help` | Usage notes |

Collapsed cards show the last 8 requests / first 40 body lines; the global
tool-output expansion toggle shows the rest (up to 600 persisted lines).
Beyond that, `/wire dump` exports the full body.

## What is captured

- **Request body** — the provider payload after all host transforms
  (`before_provider_request`), i.e. the exact JSON sent: system prompt,
  messages, tools, thinking config, images. Inline strings longer than 240
  chars (base64 images especially) render elided with their true size; the
  stored body and `/wire dump` keep everything up to the capture cap.
- **Response metadata** — HTTP status, all response headers, request id, and
  time-to-first-byte (`after_provider_response`, fired before the stream body
  is consumed).
- **Endpoint identity** — provider, transport api, model, and base URL from
  the request's resolved model.

Request *headers* (auth, user-agent) are constructed below the host's
extension seam and are not exposed; the body is the wire payload itself.

## Limits

In-memory, per-process: last 32 requests within a 24 MB body budget
(single body capped at 8 MB), oldest evicted first. The buffer does not
survive session resume — rendered `/wire` cards do (they persist as session
entries, with a short plain-text summary as the only LLM-visible content).

Response pairing is FIFO: a session serializes its provider requests, so the
oldest open capture owns the next response. Concurrent sessions in one process
(subagents) can cross-wire status/timing; bodies stay exact.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit against pinned @oh-my-pi/* types
bun run selfcheck   # drives the factory with a mock ExtensionAPI; asserts capture/pairing/eviction/views
bun run preview     # renders sample list/detail/note cards against the real dark theme
bun preview.ts 80   # preview at a specific terminal width
```
