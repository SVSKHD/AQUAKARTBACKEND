import { getFirebaseAdmin } from "../config/firebaseAdmin.js";

const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Google authentication token is required",
      });
    }

    const idToken = authorization.slice(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: "Google authentication token is required",
      });
    }

    const admin = getFirebaseAdmin();
    const decodedToken = await admin.auth().verifyIdToken(idToken, true);
    const provider = decodedToken.firebase?.sign_in_provider;

    if (provider !== "google.com") {
      return res.status(403).json({
        success: false,
        message: "Please continue with Google",
      });
    }

    if (!decodedToken.email || !decodedToken.email_verified) {
      return res.status(403).json({
        success: false,
        message: "A verified Google email is required",
      });
    }

    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email.toLowerCase(),
      emailVerified: Boolean(decodedToken.email_verified),
      name: decodedToken.name || "",
      picture: decodedToken.picture || "",
      provider,
    };

    return next();
  } catch (error) {
    const statusCode = error.statusCode || 401;

    return res.status(statusCode).json({
      success: false,
      message:
        statusCode === 503
          ? "Google authentication is not configured"
          : "Invalid or expired Google authentication token",
    });
  }
};

export default verifyFirebaseToken;
