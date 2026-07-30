import admin from "firebase-admin";

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

let firebaseAdmin = null;

if (missingEnv.length === 0) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }

  firebaseAdmin = admin;
} else {
  console.warn(
    `Firebase Admin is not configured. Missing: ${missingEnv.join(", ")}`,
  );
}

export const getFirebaseAdmin = () => {
  if (!firebaseAdmin) {
    const error = new Error("Firebase Admin credentials are not configured");
    error.statusCode = 503;
    throw error;
  }

  return firebaseAdmin;
};

export default firebaseAdmin;
