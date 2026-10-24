// Modular entry points: under ESM ("type": "module") the default
// `firebase-admin` namespace import has no `apps`, so `admin.apps.length` threw.
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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
    return applicationDefault();
  }

  const missingEnv = requiredInlineEnv.filter((key) => !process.env[key]);
  if (missingEnv.length) throw configurationError();

  return cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
};

export const initializeFirebaseAdmin = () => {
  if (firebaseAdmin) return firebaseAdmin;

  try {
    const app = getApps()[0] || initializeApp({ credential: getCredential() });
    // Same shape callers already use: getFirebaseAdmin().auth().verifyIdToken()
    firebaseAdmin = { app, auth: () => getAuth(app) };
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
