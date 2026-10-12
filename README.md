# Session Voice

A local PWA for viewing root OpenCode sessions, sending text instructions, and managing persistent goals. Speech input uses browser speech recognition. The server proxies OpenCode requests; its credentials never reach the browser.

## Run locally

Node.js 20 or newer. Configure the OpenCode server, then:

```sh
npm install
npm start
```

Visit `http://127.0.0.1:4173`. The bind default is loopback. Configure OIDC for authentication even on local runs; without OIDC, only loopback access is allowed for local development. Do not expose that mode to a network. Polling defaults to five seconds (minimum two seconds).

## Configuration

| Variable                   | Default                 | Description                                                                                                                               |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                     | `127.0.0.1`             | Bind address. Non-loopback requires OIDC plus HTTPS `APP_URL`.                                                                            |
| `PORT`                     | `4173`                  | HTTP listen port.                                                                                                                         |
| `APP_URL`                  | `http://127.0.0.1:4173` | Canonical origin and OIDC callback base; external access must use HTTPS.                                                                  |
| `OIDC_ISSUER`              | unset                   | Approved issuer, e.g. `https://auth.api.apphor.de` (prod) or `https://auth.lab.apphor.de` (testing).                                      |
| `OIDC_CLIENT_ID`           | unset                   | OIDC client ID; register `${APP_URL}/auth/callback`.                                                                                      |
| `OIDC_CLIENT_SECRET`       | unset                   | OIDC client secret.                                                                                                                       |
| `OPENCODE_URL`             | `http://127.0.0.1:4096` | OpenCode server origin. The app uses the documented `/api/session`, `/api/session/{id}/message`, and `/api/session/{id}/prompt` V2 paths. |
| `OPENCODE_SERVER_USERNAME` | `opencode`              | OpenCode Basic-auth username.                                                                                                             |
| `OPENCODE_SERVER_PASSWORD` | unset                   | OpenCode Basic-auth password (legacy `OPENCODE_USERNAME` / `OPENCODE_PASSWORD` aliases supported).                                        |
| `POLL_INTERVAL_MS`         | `5000`                  | Session refresh interval.                                                                                                                 |
| `DATA_FILE`                | `data/goals.json`       | Private persistent goals JSON file (excluded from Git).                                                                                   |
| `OPENAI_API_KEY`           | unset                   | Enables optional server-side `/api/tts`; key is never sent to the browser.                                                                |

OIDC uses authorization-code flow with state, nonce, S256 PKCE, server-side sessions, and HttpOnly SameSite=Lax cookies (Secure when HTTPS). Sessions expire after at most eight hours and restart clears them. Authenticated browser mutations must have same-origin `Origin`. Login, callback, signed-out landing, and `/healthz` are unauthenticated. There is no static bearer-token mode. Prompts are limited to discovered root-session IDs. OpenCode activity is read from the documented `/api/session/active` endpoint.

Goal APIs: `GET/POST /api/goals`, `PATCH/DELETE /api/goals/{id}`, and `POST /api/goals/{id}/send` with `{ "sessionId": "..." }`. Goal writes use a temporary file and atomic rename; clients cannot supply filesystem paths. TTS accepts `POST /api/tts` with `{ "text": "..." }` (maximum 1,000 characters); `GET /api/tts/status` reports whether it is configured.

## Development checks

```sh
npm test
npm run lint
npm run format:check
AUTH_LAB_COOKIE_JAR=/secure/path/auth-cookie-jar SESSION_VOICE_BASE_URL=http://127.0.0.1:4173 pnpm exec playwright test
```

The OpenCode V2 API contract is documented at https://opencode.ai/v2/openapi.json. For public deployment, bind to `0.0.0.0`, set the exact HTTPS `APP_URL`, use the production Auth issuer/client credentials, and persist `/data` outside the container. Never deploy with the Auth Lab issuer. The domain `openvoice.apphor.de` must not be exposed until production OIDC credentials are configured.
