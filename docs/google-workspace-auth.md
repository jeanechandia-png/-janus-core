# Google Workspace authentication boundary

Janus Core does not own Google credentials. Google is a replaceable Tool Gateway adapter.

## Current read-only capabilities

| Janus action | Google API | Recommended scope |
| --- | --- | --- |
| `drive.files.search` | Drive API v3 `files.list` | `https://www.googleapis.com/auth/drive.metadata.readonly` |
| `gmail.messages.search` | Gmail API `users.messages.list` + `users.messages.get` | `https://www.googleapis.com/auth/gmail.readonly` |
| `calendar.events.list` | Calendar API v3 `events.list` | `https://www.googleapis.com/auth/calendar.events.readonly` |

## Important Gmail constraint

Gmail's `q` search parameter cannot be used with `gmail.metadata`. Searching the mailbox therefore requires `gmail.readonly` (or a broader scope). Google classifies `gmail.readonly` as a restricted scope.

Janus must not silently upgrade Gmail permissions. If we later decide that mailbox search is not worth that scope, the Gmail adapter can be reduced to metadata/list operations without `q`.

## Credential rules

- Never commit OAuth client secrets, access tokens, refresh tokens, cookies, or exported browser sessions.
- Never store Google refresh tokens in SQLite.
- `GOOGLE_ACCESS_TOKEN` is supported only as a temporary development bridge.
- Production/local-first Janus should obtain tokens from a secure OS credential provider (for example Keychain on Apple platforms) or an equivalent encrypted credential agent.
- The Tool Adapter receives an ephemeral access token or token-provider callback and must never include credentials in ToolResult, events, logs, or artifacts.
- Offline queued writes must be revalidated after reconnect before execution.

## Runtime configuration

- `GOOGLE_ACCESS_TOKEN`: optional ephemeral development access token.
- `JANUS_TIME_ZONE`: optional IANA timezone used as planning context (for example `Europe/Amsterdam`). It is configuration, not hardcoded user state.

## Next security milestone

Implement a local OAuth 2.0 Authorization Code + PKCE credential agent with refresh-token storage in the operating system secure credential store. Janus Core should receive only short-lived access tokens from that agent.
