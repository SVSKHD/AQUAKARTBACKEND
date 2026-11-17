# Runtime configuration (aqua-env)

Last reviewed: 2026-11-14 (Asia/Calcutta).

Configuration variables live in the MongoDB collection **`aqua-env`** and are
managed from the CRM. The server environment (`.env` or Doppler) keeps only
the two bootstrap values:

| Variable                  | Why it stays in the server environment                  |
| ------------------------- | ------------------------------------------------------- |
| `DB_URL`                  | Needed to reach the database that holds everything else |
| `AQUA_ENV_ENCRYPTION_KEY` | Decrypts the stored values; 32 bytes as 64 hex chars    |

Generate the key once with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and
keep a copy in a password manager. **Losing it makes every stored value
unreadable**; there is no key rotation command yet.

## How startup works

`index.js`:

1. `config.js` loads `.env` (unless `DOPPLER_PROJECT` is set).
2. Connects MongoDB with `DB_URL` (10 attempts, 15 s apart). The server now
   waits for this before listening.
3. `aquaEnvStore.load()` (`src/services/aquaEnv.js`) decrypts every document
   and writes it into `process.env`. **Stored values win over `.env`**; `.env`
   remains the fallback for keys that are not stored.
4. Only then imports `app.js` and the rest, because many modules read
   `process.env` when first imported.

The log line `aqua-env: loaded N of M variables` reports key names only. A
record that cannot be decrypted (wrong/missing key, tampered data) is listed by
name and its `.env` value, if any, stays in use. If MongoDB is unreachable the
server starts with server-environment values only, as before.

Reserved names are never read from or written to `aqua-env`: `DB_URL`,
`AQUA_ENV_ENCRYPTION_KEY`, `PORT`, OS variables (`PATH`, `HOME`, `TMP`, ...)
and anything starting with `NODE_`, `NPM_`, `PM2_`, `DOPPLER_`, `LD_`, `DYLD_`.

## Storage

`src/models/aquaEnv.js`, one document per variable:

| Field         | Notes                                                      |
| ------------- | ---------------------------------------------------------- |
| `key`         | Unique, `^[A-Z][A-Z0-9_]{0,99}$`                           |
| `value`       | `{ v, iv, tag, data }`: AES-256-GCM, key name bound as AAD |
| `secret`      | Default true; secrets are masked in every response         |
| `description` | Optional, max 300 characters                               |
| `updatedBy`   | Staff id; `createdAt`/`updatedAt` timestamps               |

Every value is encrypted, secret or not, so a database dump or backup alone
does not reveal configuration.

## CRM API (`/v1/crm/env`)

Staff JWT. New permissions `settings.read` and `settings.manage` are not in any
role by default, so only super-admins and legacy `role: 1` admins have them.
`settings.manage` controls credentials such as `JWT_SECRET`; grant it sparingly.

| Method and path           | Permission        | Behavior                                                                                 |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `GET /v1/crm/env`         | `settings.read`   | All stored variables (secrets masked) plus `status.lastLoad` from startup                |
| `GET /v1/crm/env/:key`    | `settings.read`   | One variable; 404 if not stored                                                          |
| `PUT /v1/crm/env/:key`    | `settings.manage` | Create (201, `value` required) or partial update (200); 400 reserved/invalid; 503 no key |
| `DELETE /v1/crm/env/:key` | `settings.manage` | Remove; `fallback: "server-env"` or `"none"`                                             |

- Masking: secrets of 12+ characters show `••••` plus the last 4 characters;
  shorter ones show only `••••`. Full secret values are never returned; to
  change one, PUT a new value.
- `readable: false` / `value: null` means the server cannot decrypt it.
  `inEffect` says whether `process.env` on that instance holds the stored value.
- Audit log actions `settings.env.create`, `settings.env.update`,
  `settings.env.delete` record the key, the `secret` flag, the description and
  whether the value changed, never the value.

### When a change takes effect

A PUT/DELETE updates `process.env` immediately **on the instance that handled
the request**. Code that reads `process.env` per request (for example JWT
verification, PhonePe, GSTIN lookup, Gemini) uses the new value right away.
Values read once at startup need a restart, including: Cloudinary
(`CLOUDINARY_*`), WhatsApp (`WHATSAPPAPI`, `WHATSAPPAPIKEY`), `ADMIN_PHONE`,
MCP and Instagram settings (`MCP_*`), CORS/proxy settings read in `app.js`, and
the scheduler. With several instances, the others pick up changes on restart.
Every write response includes a `restartNote` saying so.

## Migrating an existing .env

```bash
npm run env:import                         # dry run of ./.env: key names only
npm run env:import -- --file .env.prod     # dry run of another file
npm run env:import -- --apply              # store keys not yet in aqua-env
npm run env:import -- --apply --overwrite  # also replace stored keys
```

Needs `DB_URL` and `AQUA_ENV_ENCRYPTION_KEY`. Reserved and empty values are
skipped. Names that look like secrets (`KEY`, `SECRET`, `PASSWORD`, `TOKEN`,
`PIN`, ...) and anything not clearly a plain setting are stored as secrets.
After `--apply`, the script decrypts everything back and reports failures by
name. Then remove the copied keys from `.env`/Doppler, keeping only the
bootstrap pair, and restart.

`npm run mcp:grants` also loads `aqua-env` after connecting. The seed scripts
(`seed:blog:*`) and `role` still read only the server environment.

## Limitations

- No key rotation: changing `AQUA_ENV_ENCRYPTION_KEY` needs a re-encrypt step
  (not implemented).
- No live propagation across instances; restart them after edits.
- `GOOGLE_APPLICATION_CREDENTIALS` is a file path; the file itself still has to
  be mounted on the server.
- The CRM screen is not part of this repository.
