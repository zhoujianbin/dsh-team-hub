import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function generatePassword(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const actual = crypto.scryptSync(password, salt, Buffer.from(expectedHash, "hex").length, SCRYPT);
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}
