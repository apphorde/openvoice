# OpenVoice

A local PWA for viewing root OpenCode sessions, sending text instructions, and managing persistent goals. Speech input uses browser speech recognition. The server proxies OpenCode requests; its credentials never reach the browser.

## Voice-first interface

The Li³ reactive single-page app shows the voice note first; use **Chat** to switch to conversation history and typed instructions. Use **Switch** to choose or create a session; the last selection is remembered on this browser. **Start hands-free** enables dictation. Chrome's revised speech-result snapshots replace interim text instead of appending it, while separate finalized words are preserved. A pause stages an editable draft; it is never sent automatically. Choose **Send** to submit, **Resume dictation** to continue editing by voice, or **Discard** to clear it. The microphone indicator changes to listening only after browser recognition has actually started; status text identifies off, waiting, and review states. After a reply is read, listening resumes if hands-free is still enabled, and the next instruction again requires confirmation. Tap **Stop voice** at any time to pause. Executive goals stay in the session menu; broadcasting goals still requires confirmation.

The browser bundle includes the Li³ runtime from the source commit documented in `src/vendor/README.md`, because the current published npm package does not yet include Li³'s documented `codePlan` support. Li³'s generated binding plans use Blob modules, so the page CSP permits `blob:` in `script-src` but continues to forbid `unsafe-eval`; all app scripts and assets are served from this origin.

Hands-free use requires a browser supporting SpeechRecognition, microphone permission, and configured server-side TTS. Browser recognition may use the browser vendor's speech service. Keep the app open and foregrounded; locked-screen/background listening is not guaranteed. Browser autoplay restrictions can require another interaction before audio can play. Typed instructions remain available when voice is unsupported. Stopping voice does not cancel an instruction already delivered to OpenCode.

## Run locally

Node.js 20 or newer. Configure the OpenCode server, then:

```sh
npm install
npm run build
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
| `OIDC_ALLOWED_SUBS`        | empty                   | Optional comma-separated list of OIDC `sub` values allowed to sign in.                                                                    |
| `OPENCODE_URL`             | `http://127.0.0.1:4096` | OpenCode server origin. The app uses the documented `/api/session`, `/api/session/{id}/message`, and `/api/session/{id}/prompt` V2 paths. |
| `OPENCODE_SERVER_USERNAME` | `opencode`              | OpenCode Basic-auth username.                                                                                                             |
| `OPENCODE_SERVER_PASSWORD` | unset                   | OpenCode Basic-auth password (legacy `OPENCODE_USERNAME` / `OPENCODE_PASSWORD` aliases supported).                                        |
| `POLL_INTERVAL_MS`         | `5000`                  | Session refresh interval.                                                                                                                 |
| `DATA_FILE`                | `data/goals.json`       | Private persistent goals JSON file (excluded from Git).                                                                                   |
| `OPENAI_API_KEY`           | unset                   | Enables optional server-side `/api/tts`; key is never sent to the browser.                                                                |

OIDC uses authorization-code flow with state, nonce, S256 PKCE, server-side sessions, and HttpOnly SameSite=Lax cookies (Secure when HTTPS). Sessions expire after at most eight hours and restart clears them. Authenticated browser mutations must have same-origin `Origin`. Login, callback, signed-out landing, and `/healthz` are unauthenticated. There is no static bearer-token mode. Prompts are limited to discovered root-session IDs. OpenCode activity is read from the documented `/api/session/active` endpoint.

Goal APIs: `GET/POST /api/goals`, `PATCH/DELETE /api/goals/{id}`, `POST /api/goals/{id}/send` with `{ "sessionId": "..." }`, and `POST /api/plan/send` with 1–250 discovered root-session IDs. The all-session UI action requires confirmation and sends with concurrency capped at five; failed deliveries are reported. Goal writes use a temporary file and atomic rename; clients cannot supply filesystem paths. TTS accepts `POST /api/tts` with `{ "text": "..." }` (maximum 1,000 characters); `GET /api/tts/status` reports whether it is configured.

## Development checks

```sh
npm run build
npm test
npm run lint
npm run format:check
# Against an isolated local development server (no live OpenCode writes):
npm run test:e2e -- e2e/voice-ui.spec.js
# Against a local server configured with a temporary Auth Lab client:
AUTH_LAB_COOKIE_JAR=/secure/path/auth-cookie-jar SESSION_VOICE_BASE_URL=http://127.0.0.1:4173 EXPECTED_OIDC_ORIGIN=https://auth.lab.apphor.de npm run test:e2e -- e2e/app.spec.js e2e/public-smoke.spec.js
# Read-only production boundary smoke test:
SESSION_VOICE_BASE_URL=https://openvoice.apphor.de npm run test:e2e -- e2e/public-smoke.spec.js
```

The OpenCode V2 API contract is documented at https://opencode.ai/v2/openapi.json. For public deployment, bind to `0.0.0.0`, set the exact HTTPS `APP_URL`, use the production Auth issuer/client credentials, and persist `/data` outside the container. Never deploy with the Auth Lab issuer. The domain `openvoice.apphor.de` must not be exposed until production OIDC credentials are configured.

## Container image

```sh
docker build -t ghcr.io/apphorde/openvoice:latest .
docker push ghcr.io/apphorde/openvoice:latest
```

The image builds the Tailwind v4 stylesheet and bundled browser code before pruning development dependencies, then starts with `npm start`. It extends `ghcr.io/cloud-cli/image-node:latest`, contains the application in `/home/app`, and listens on port 4173. Credentials must be supplied at runtime. Mount persistent goal storage at `/data`, not over the bundled application. The Cloudy service is named `openvoice.apphor.de`; re-fetch its definition and environment before deploying so operator changes are preserved.
