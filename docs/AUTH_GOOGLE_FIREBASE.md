# Google Authentication Handshake

Credentials are intentionally not committed. Configure Firebase client values in AQUAKARTECOM and Firebase Admin values in AQUAKARTBACKEND.

Flow:
1. Next.js authenticates with Google through Firebase.
2. Frontend obtains Firebase ID token.
3. Frontend sends `Authorization: Bearer <token>` to `POST /v1/auth/google`.
4. Backend verifies the token with Firebase Admin.
5. Backend finds the user by Firebase UID, then normalized email for legacy-account linking.
6. Backend creates or updates the MongoDB user.
7. Backend returns `isNewUser`, `message`, an Aquakart JWT, and safe user data.
8. Frontend shows `Welcome to Aquakart, <name>!` for new users or `Welcome back, <name>!` for returning users.

Required backend environment variables:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `JWT_SECRET`
