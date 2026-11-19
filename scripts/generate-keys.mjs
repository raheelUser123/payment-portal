#!/usr/bin/env node
// Prints fresh secrets for .env — run: npm run gen:keys
import { randomBytes } from "node:crypto";
const b64 = (n) => randomBytes(n).toString("base64");
const url = (n) => randomBytes(n).toString("base64url");
console.log(`ENCRYPTION_KEY=${b64(32)}`);
console.log(`APP_SECRET=${url(48)}`);
console.log(`SETUP_TOKEN=${url(24)}`);
console.log(`CRON_SECRET=${url(32)}`);
