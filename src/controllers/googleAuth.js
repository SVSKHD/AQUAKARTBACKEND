import AquaEcomUser from "../models/user.js";
import { userRoleSlug } from "../constants/roles.js";
import { revokeSession } from "../services/auth/sessionRevocation.js";

const firstNameFrom = (name = "") => name.trim().split(/\s+/)[0] || "";

const splitName = (name = "") => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
};

const safeUser = (user) => ({
  _id: user._id,
  id: user._id,
  firebaseUid: user.firebaseUid,
  email: user.email,
  firstName: user.firstName || "",
  lastName: user.lastName || "",
  photoURL: user.photoURL || user.photo?.secure_url || "",
  emailVerified: Boolean(user.emailVerified || user.isEmailVerfied),
  phone: user.phone || null,
  role: user.role,
  // "admin" | "tester" | "user" (the default).
  roleName: userRoleSlug(user),
  dob: user.dob || null,
  // The address book is the account's: every device and page reads it from here.
  addresses: user.addresses || [],
  selectedAddress: user.selectedAddress || null,
});

const googleLogin = async (req, res) => {
  try {
    const firebaseUser = req.firebaseUser;
    const now = new Date();

    let user = await AquaEcomUser.findOne({
      firebaseUid: firebaseUser.uid,
    });

    if (!user) {
      user = await AquaEcomUser.findOne({ email: firebaseUser.email });
    }

    const isNewUser = !user;
    const googleName = splitName(firebaseUser.name);

    if (user?.firebaseUid && user.firebaseUid !== firebaseUser.uid) {
      return res.status(409).json({
        success: false,
        authenticated: false,
        message: "This email is already linked to another Google account",
      });
    }

    if (isNewUser) {
      user = await AquaEcomUser.create({
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email,
        isEmailVerfied: firebaseUser.emailVerified,
        emailVerified: firebaseUser.emailVerified,
        isGoogleLogin: true,
        authProvider: "google.com",
        firstName: googleName.firstName,
        lastName: googleName.lastName,
        photoURL: firebaseUser.picture,
        phone: undefined,
        firstLoginAt: now,
        lastLoginAt: now,
        loginCount: 1,
        googleData: {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          picture: firebaseUser.picture,
        },
      });
    } else {
      user.firebaseUid ||= firebaseUser.uid;
      user.isGoogleLogin = true;
      user.isEmailVerfied = firebaseUser.emailVerified;
      user.emailVerified = firebaseUser.emailVerified;
      user.authProvider = "google.com";
      user.firstName ||= googleName.firstName;
      user.lastName ||= googleName.lastName;
      user.photoURL = firebaseUser.picture || user.photoURL;
      user.firstLoginAt ||= user.createdAt || now;
      user.lastLoginAt = now;
      user.loginCount = (user.loginCount || 0) + 1;
      user.googleData = {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        picture: firebaseUser.picture,
      };

      await user.save();
    }

    const token = user.generateAuthToken();
    const name = firstNameFrom(user.firstName || firebaseUser.name);
    const message = isNewUser
      ? `Welcome to Aquakart${name ? `, ${name}` : ""}!`
      : `Welcome back${name ? `, ${name}` : ""}!`;

    return res.status(isNewUser ? 201 : 200).json({
      success: true,
      authenticated: true,
      isNewUser,
      message,
      token,
      user: safeUser(user),
    });
  } catch (error) {
    console.error("Google authentication failed:", error.message);

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "An account already exists with this Google email",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to complete Google authentication",
    });
  }
};

const me = async (req, res) =>
  res.status(200).json({
    success: true,
    authenticated: true,
    user: safeUser(req.user),
  });

const bearer = (value = "") =>
  String(value)
    .replace(/^Bearer\s+/i, "")
    .trim();

// Cancels this device's session token (and the X-Aquakart-Session copy the
// pay page sends, when different) so it stops working at once. Always 200:
// signing out must succeed even with an expired or already-cancelled token.
const logout = async (req, res, deps = { revokeSession }) => {
  const tokens = [
    ...new Set(
      [
        bearer(req.get?.("authorization")),
        bearer(req.get?.("x-aquakart-session")),
      ].filter(Boolean),
    ),
  ];
  try {
    await Promise.all(tokens.map((token) => deps.revokeSession(token)));
  } catch (error) {
    console.error("Session revoke failed:", error?.message);
    return res.status(503).json({
      success: false,
      message: "Couldn't finish signing out. Please try again.",
    });
  }
  return res.status(200).json({
    success: true,
    authenticated: false,
    message: "Signed out successfully",
  });
};

export { safeUser, logout };
export default { googleLogin, me, logout };
