# Google Authentication Handshake

Credentials are intentionally not committed. Configure Firebase client values in AQUAKARTECOM and Firebase Admin values in AQUAKARTBACKEND.

Flow:

1. Next.js authenticates with Google through Firebase.
2. Frontend obtains Firebase ID token.
3. Frontend sends `Authorization: Bearer <token>` to `POST /v1/auth/google`.
4. Backend verifies the token with Firebase Admin.
5. Backend finds the user by Firebase UID, then normalized email for legacy-account linking.
6. Backend creates or updates the MongoDB user.
7. Backend returns `isNewUser`, `message`, an Aquakart JWT, and safe user data
   (`safeUser()`), which includes `dob`, `addresses` and `selectedAddress` so every
   device reads the account's address book. `GET /v1/auth/me` returns the same shape.
8. Frontend shows `Welcome to Aquakart, <name>!` for new users or `Welcome back, <name>!` for returning users.

Profile and address updates (`POST /v1/user/update-details/:id`, logged in):

- Only the signed-in user's own id is accepted; any other id returns 403.
- Only `firstName`, `lastName`, `phone`, `dob`, `alternativeEmail`, `photo`,
  `gstDetails`, `addresses` and `selectedAddress` are saved. Other keys, dotted
  paths and `$` operators are dropped.
- `email` comes from the sign-in account: resending the current value is ignored,
  and a different value returns 400.
- An empty `phone` removes the field. A phone already used by another account
  returns 409, and invalid values return 400.
- The response is the updated user without the password hash.

Required backend environment variables:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `JWT_SECRET`
