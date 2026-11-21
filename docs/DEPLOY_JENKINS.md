# Jenkins deploy

The production backend is built and started by the Jenkins job
`AQUABACKEND` on every push to `main`, using the repository's `Jenkinsfile`:

1. Build the Docker image `aquakartbackendapp:<build number>` (also tagged
   `latest`).
2. Copy the Firebase service account into the `aquakart_firebase_secrets`
   volume.
3. Replace the `aquakartbackend_container` container.
4. Verify it: the Firebase file is mounted, then `GET /v1/status` is retried
   every 2 s for up to 90 s (the app connects to MongoDB and loads aqua-env
   before it listens). If the container stops or never answers, the build
   fails and the last 200 log lines are printed.

Secrets are never passed as `-e NAME=value` (Jenkins prints command lines in
the build log). They come from an env file credential, and every shell step
starts with `set +x`.

## One-time Jenkins setup

1. **Env file credential.** Manage Jenkins → Credentials → Add → _Secret
   file_, ID `aquakart-backend-env`. The file has one `NAME=value` per line,
   no quotes, no `export`. Put every runtime variable the container needs in
   it, for example `DB_URL`, `JWT_SECRET`, `CLOUDINARY_NAME`,
   `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `PHONEPE_MERCHANTID`,
   `PHONEPE_KEY`, `FAST2SMS_*`, `GEMINI_KEY`, `GST_ENABLE_KEY`,
   `AQUA_ENV_ENCRYPTION_KEY`, `SERVICE_PORTAL_PIN`, `SMTPEMAIL`,
   `SMTPEMAILPASSWORD`, `META_WA_VERIFY_TOKEN`, `MCP_PUBLIC_BASE_URL`,
   `TESTING_MODE`, and the rest listed in `.env.example`. `NODE_ENV`, `PORT`
   and `GOOGLE_APPLICATION_CREDENTIALS` are set by the Jenkinsfile.
   Variables saved in the CRM environment settings (aqua-env) are loaded on
   top of these at startup.
2. **Firebase credential.** The existing _Secret file_ with the Firebase
   service account JSON. The Jenkinsfile expects ID
   `aquakart-firebase-service-account`; change `FIREBASE_CREDENTIAL` at the
   top of the Jenkinsfile if yours differs.
3. **Job definition.** In the job's Configure → Pipeline, choose _Pipeline
   script from SCM_, Git, `https://github.com/SVSKHD/AQUAKARTBACKEND.git`,
   branch `*/main`, script path `Jenkinsfile`. Keep the GitHub push trigger.
4. Build once and check the "Health check passed" line.

Until step 3 is done the job keeps running its inline script, which still
uses a fixed 8 s sleep and prints the secrets. To fix only the health check
there, replace its `sleep 8` + `curl --fail .../v1/status` with the retry
loop from the Jenkinsfile's "Verify Container" stage.

## After a leak

If secrets have appeared in a build log, rotate them (new values in the env
file credential and at each provider), then delete those old builds in
Jenkins.
