import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRand: number[] = [];

function randomDigits(): number[] {
  const bytes = randomBytes(10);
  const digits: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      digits.push((acc >> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  return digits;
}

/**
 * ULID-style sortable ID: 48-bit time + 80 random bits, Crockford base32, with a type prefix.
 * Monotonic (as the ULID spec describes): an ID made in the same millisecond as the previous one, or with a
 * clock that went backwards, keeps the previous time and increments the random part, so IDs always sort in
 * creation order within this process. Lists ordered by (created_at, id) rely on that.
 */
export function newId(prefix: string, now = Date.now()): string {
  let t = now;
  let digits: number[];
  if (t <= lastTime && lastRand.length === 16) {
    t = lastTime;
    digits = [...lastRand];
    let i = digits.length - 1;
    while (i >= 0 && digits[i] === 31) {
      digits[i] = 0;
      i--;
    }
    if (i < 0) {
      // 80-bit overflow within one millisecond: move to the next millisecond.
      t = lastTime + 1;
      digits = randomDigits();
    } else digits[i]! += 1;
  } else digits = randomDigits();
  lastTime = t;
  lastRand = digits;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${time}${digits.map((d) => CROCKFORD[d]).join("")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** AES-256-GCM with a key derived from the server secret. Used for integration and webhook secrets. */
export function encrypt(secret: string, plaintext: string): string {
  const key = createHash("sha256").update("omb-encryption:" + secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decrypt(secret: string, payload: string): string {
  const [v, iv, tag, enc] = payload.split(".");
  if (v !== "v1" || !iv || !tag || enc === undefined) throw new Error("bad ciphertext");
  const key = createHash("sha256").update("omb-encryption:" + secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
}
