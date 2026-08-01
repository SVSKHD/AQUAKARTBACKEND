import admin from "firebase-admin";

const requiredInlineEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
];

let firebaseAdmin = null;

const configurationError = () => {
  const error = new Error("Firebase Admin credentials are not configured");
  error.statusCode = 503;
  return error;
};

const getCredential = () => {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }

  const missingEnv = requiredInlineEnv.filter((key) => !process.env[key]);
  if (missingEnv.length) throw configurationError();

  return admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
};

export const initializeFirebaseAdmin = () => {
  if (firebaseAdmin) return firebaseAdmin;

  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: getCredential() });
    }
    firebaseAdmin = admin;
    return firebaseAdmin;
  } catch (error) {
    if (error.statusCode === 503) throw error;
    console.error("Firebase Admin initialization failed:", error.message);
    throw configurationError();
  }
};

export const getFirebaseAdmin = () =>
  firebaseAdmin || initializeFirebaseAdmin();

export default firebaseAdmin;
