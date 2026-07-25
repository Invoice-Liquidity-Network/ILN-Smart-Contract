"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
const crypto_1 = __importDefault(require("crypto"));
const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
/**
 * Encrypts a string using a password.
 */
function encrypt(text, password) {
    const key = crypto_1.default.scryptSync(password, "salt", 32);
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return `${iv.toString("hex")}:${encrypted}`;
}
/**
 * Decrypts a string using a password.
 */
function decrypt(encryptedText, password) {
    const [ivHex, encrypted] = encryptedText.split(":");
    if (!ivHex || !encrypted) {
        throw new Error("Invalid encrypted text format");
    }
    const key = crypto_1.default.scryptSync(password, "salt", 32);
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
//# sourceMappingURL=crypto.js.map