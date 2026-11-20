import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import RevokedSession from "../../models/revokedSession.js";

// Sign-out for customer sessions. A JWT can't be "deleted", so POST
// /auth/logout records its hash here and every customer auth check
// (middleware/user.js, optionalUser.js, googleSession.js) refuses it.

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // generateAuthToken's 30d

export const hashSessionToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

export const defaultDeps = {
  // Without a database connection the account lookup beside this check fails
  // anyway; skipping here keeps DB-less tests from waiting on Mongoose buffering.
  connected: () => mongoose.connection.readyState === 1,
  findOne: (query) => RevokedSession.findOne(query).select("_id").lean(),
  upsert: (doc) =>
    RevokedSession.updateOne(
      { tokenHash: doc.tokenHash },
      { $setOnInsert: doc },
      { upsert: true },
    ),
};

export const isSessionRevoked = async (token, deps = defaultDeps) => {
  if (!token || deps.connected?.() === false) return false;
  return Boolean(await deps.findOne({ tokenHash: hashSessionToken(token) }));
};

// Revokes one token. Invalid or expired tokens need nothing; returns whether a
// row was written.
export const revokeSession = async (token, deps = defaultDeps) => {
  if (!token) return false;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return false;
  }
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + DEFAULT_TTL_MS);
  await deps.upsert({
    tokenHash: hashSessionToken(token),
    userId: decoded?._id,
    expiresAt,
  });
  return true;
};

export const REVOKED_MESSAGE = "You have signed out. Please sign in again.";
