import { generatePassword, hashPassword, verifyPassword } from "./passwords.mjs";

export function publicUser(user) {
  return {
    name: user.name,
    role: user.role,
    status: user.status || "active",
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

export function findUser(config, name) {
  return config.users.find(u => u.name === name) || null;
}

export function createUser(config, { name, role = "member", password = generatePassword() }) {
  if (findUser(config, name)) throw new Error(`用户已存在：${name}`);
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  const user = { name, role, status: "active", salt, hash, mustChangePassword: true, createdAt: now, updatedAt: now };
  config.users.push(user);
  return { user, initialPassword: password };
}

export function setUserStatus(config, name, status) {
  const user = findUser(config, name);
  if (!user) throw new Error(`用户不存在：${name}`);
  if (user.role === "admin" && status === "disabled") {
    const activeAdmins = config.users.filter(u => u.role === "admin" && (u.status || "active") === "active" && u.name !== name);
    if (activeAdmins.length === 0) throw new Error("不能禁用最后一个启用的 admin");
  }
  user.status = status;
  user.updatedAt = new Date().toISOString();
  return user;
}

export function resetPassword(config, name, password = generatePassword()) {
  const user = findUser(config, name);
  if (!user) throw new Error(`用户不存在：${name}`);
  const { salt, hash } = hashPassword(password);
  user.salt = salt;
  user.hash = hash;
  user.mustChangePassword = true;
  user.updatedAt = new Date().toISOString();
  return { user, initialPassword: password };
}

export function changePassword(config, name, currentPassword, nextPassword) {
  const user = findUser(config, name);
  if (!user || !verifyPassword(currentPassword, user.salt, user.hash)) throw new Error("当前密码不正确");
  if (typeof nextPassword !== "string" || nextPassword.length < 8) throw new Error("新密码至少 8 位");
  const { salt, hash } = hashPassword(nextPassword);
  user.salt = salt;
  user.hash = hash;
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  return user;
}

export function authenticate(config, name, password) {
  const user = findUser(config, name);
  if (!user || (user.status || "active") !== "active") return null;
  if (!verifyPassword(password, user.salt, user.hash)) return null;
  user.lastLoginAt = new Date().toISOString();
  return user;
}
