/**
 * Image egress test: upload a local image to Octo storage via the presigned
 * direct-upload flow and send it as an image message (payload.type=2).
 *
 * Pure REST - no WebSocket, no re-registration, so it never disturbs a
 * running service instance.
 *
 * Usage: node scripts/send-image-test.mjs [imagePath]
 * Env:   OCTO_TARGET_UID (default: the first dm: conversation in the
 *        session map, i.e. the bot owner).
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  getPresignedUpload,
  pngSizeOf,
  sendMediaMessage,
  uploadToPresignedUrl,
} from "../lib/protocol/api-fetch.js";

const configPath = process.env.CODEX_OCTO_CONFIG ?? "/root/.codex-octo-channel/config.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
const apiUrl = process.env.OCTO_API_URL ?? config.apiUrl;
const botToken = process.env.OCTO_TOKEN ?? config.botToken;
const imagePath = process.argv[2] ?? "/www/wwwroot/new-api/web/dist/logo.png";

let target = process.env.OCTO_TARGET_UID ?? "";
if (target === "") {
  try {
    const stateRoot = (config.stateRoot ?? process.env.HOME + "/.codex-octo-channel").replace("~", process.env.HOME);
    const map = JSON.parse(readFileSync(stateRoot + "/session-map.json", "utf8"));
    const dmKey = Object.keys(map.sessions ?? {}).find((k) => k.startsWith("dm:"));
    target = dmKey?.slice(3) ?? "";
  } catch {
    /* fall through */
  }
}
if (target === "") {
  console.error("send-image-test: no target uid - set OCTO_TARGET_UID");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(imagePath));
console.log("image:", imagePath, bytes.byteLength, "bytes");

const presigned = await getPresignedUpload({ apiUrl, botToken, filename: imagePath.split("/").pop(), fileSize: bytes.byteLength });
console.log("presigned ok, key:", presigned.key ?? "?", "type:", presigned.contentType ?? "?");

await uploadToPresignedUrl({ presigned, bytes });
console.log("upload ok ->", presigned.downloadUrl.slice(0, 80) + "…");

const result = await sendMediaMessage({
  apiUrl,
  botToken,
  channelId: target,
  channelType: 1,
  messageType: 2,
  url: presigned.downloadUrl,
  meta: pngSizeOf(bytes),
});
console.log("image message sent to", target, "messageId:", result?.message_id ?? "?");
