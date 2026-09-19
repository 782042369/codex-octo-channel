import { EventEmitter } from "events";
import WebSocket from "ws";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type { BotMessage, MessagePayload } from "./types.js";

// ─── WuKongIM Binary Protocol Constants ─────────────────────────────────────

const enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  SEND = 3,
  SENDACK = 4,
  RECV = 5,
  RECVACK = 6,
  PING = 7,
  PONG = 8,
  DISCONNECT = 9,
}

const PROTO_VERSION = 4;
/** Maximum retained parser bytes across fragmented WebSocket frames. */
export const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Maximum one WuKongIM packet accepted by the framing layer. */
export const MAX_PACKET_BYTES = 2 * 1024 * 1024;
/** Maximum bytes used by the remaining-length varint. */
const MAX_VARINT_BYTES = 4;

// ─── Binary Encoder / Decoder ───────────────────────────────────────────────

class Encoder {
  private w: number[] = [];
  writeByte(b: number) { this.w.push(b & 0xff); }
  writeBytes(b: number[]) { this.w.push(...b); }
  writeInt16(b: number) { this.w.push((b >> 8) & 0xff, b & 0xff); }
  writeInt32(b: number) { this.w.push((b >> 24) & 0xff, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff); }
  writeInt64(n: bigint) {
    const hi = Number(n >> 32n);
    const lo = Number(n & 0xffffffffn);
    this.writeInt32(hi);
    this.writeInt32(lo);
  }
  writeString(s: string) {
    if (s && s.length > 0) {
      const arr = stringToUint(s);
      this.writeInt16(arr.length);
      this.w.push(...arr);
    } else {
      this.writeInt16(0);
    }
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.w); }
}

class Decoder {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  /** Ensure a bounded number of bytes remains before reading.
   * @param count - bytes required by the next primitive.
   * @returns void; throws on a truncated packet.
   */
  private ensure(count: number): void {
    if (!Number.isInteger(count) || count < 0 || this.offset + count > this.data.length) throw new Error("octo: truncated binary packet");
  }

  /** Read one byte from the packet.
   * @returns The unsigned byte value.
   */
  readByte(): number {
    this.ensure(1);
    return this.data[this.offset++];
  }

  /** Read a big-endian unsigned 16-bit integer.
   * @returns The integer value.
   */
  readInt16(): number {
    this.ensure(2);
    const v = (this.data[this.offset] << 8) | this.data[this.offset + 1];
    this.offset += 2;
    return v;
  }

  /** Read a big-endian unsigned 32-bit integer.
   * @returns The integer value.
   */
  readInt32(): number {
    this.ensure(4);
    const v = (this.data[this.offset] << 24) | (this.data[this.offset + 1] << 16) | (this.data[this.offset + 2] << 8) | this.data[this.offset + 3];
    this.offset += 4;
    return v >>> 0;
  }

  /** Read an int64 without losing decimal precision.
   * @returns The decimal string representation.
   */
  readInt64String(): string {
    this.ensure(8);
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(this.data[this.offset + i]);
    this.offset += 8;
    return n.toString();
  }

  /** Read an int64 as a bigint.
   * @returns The unsigned bigint value.
   */
  readInt64BigInt(): bigint {
    this.ensure(8);
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(this.data[this.offset + i]);
    this.offset += 8;
    return n;
  }

  /** Read a length-prefixed UTF-8 string.
   * @returns The decoded string.
   */
  readString(): string {
    const len = this.readInt16();
    if (len <= 0) return "";
    this.ensure(len);
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return uintToString(slice);
  }

  /** Read the remaining packet bytes.
   * @returns A view of the remaining payload.
   */
  readRemaining(): Uint8Array {
    const d = this.data.slice(this.offset);
    this.offset = this.data.length;
    return d;
  }

  /** Read and validate the WuKongIM remaining-length varint.
   * @returns The decoded remaining length.
   */
  readVariableLength(): number {
    let multiplier = 1;
    let rLength = 0;
    for (let index = 0; index < MAX_VARINT_BYTES; index++) {
      const b = this.readByte();
      rLength += (b & 127) * multiplier;
      if ((b & 128) === 0) return rLength;
      multiplier *= 128;
    }
    throw new Error("octo: malformed remaining-length varint");
  }
}

function stringToUint(str: string): number[] {
  const encoded = unescape(encodeURIComponent(str));
  const arr: number[] = [];
  for (let i = 0; i < encoded.length; i++) arr.push(encoded.charCodeAt(i));
  return arr;
}

/** Convert bytes to a UTF-8 string in bounded chunks.
 * @param array - byte-like input.
 * @returns Decoded UTF-8 text.
 */
function uintToString(array: ArrayLike<number>): string {
  let encoded = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < array.length; offset += chunkSize) {
    const chunk: number[] = [];
    const end = Math.min(array.length, offset + chunkSize);
    for (let index = offset; index < end; index++) chunk.push(array[index]);
    encoded += String.fromCharCode(...chunk);
  }
  return decodeURIComponent(escape(encoded));
}

function encodeVariableLength(len: number): number[] {
  if (!Number.isInteger(len) || len < 0 || len > MAX_PACKET_BYTES) throw new Error("octo: invalid packet length");
  const ret: number[] = [];
  if (len === 0) return [0];
  while (len > 0) {
    let digit = len % 0x80;
    len = Math.floor(len / 0x80);
    if (len > 0) digit |= 0x80;
    ret.push(digit);
  }
  return ret;
}

// ─── Session Crypto Helpers (node:crypto) ───────────────────────────────────
// The wire format is fixed: X25519 key exchange, AES-128-CBC payloads, and an
// MD5-of-base64 shared secret as the session key. node:crypto implements all
// three natively, so the pure-JS crypto-js / curve25519-js / md5-typescript
// dependencies are not needed.

/** DER prefix of an X25519 SPKI public key; the raw 32-byte key follows it. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Serialize the raw public half of an X25519 key pair.
 * @param key - the generated public KeyObject.
 * @returns The base64 raw 32-byte public key sent in CONNECT.
 */
function exportRawPublicKey(key: KeyObject): string {
  const der = Buffer.from(key.export({ type: "spki", format: "der" }));
  return der.subarray(X25519_SPKI_PREFIX.length).toString("base64");
}

/** Rebuild a public KeyObject from the raw key in a CONNACK.
 * @param raw - raw 32-byte X25519 public key.
 * @returns The public KeyObject consumed by diffieHellman.
 */
function importRawPublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/** Derive the 16-byte session key from the DH shared secret.
 * @param secret - raw X25519 shared secret.
 * @returns The first 16 hex characters of MD5(base64(secret)).
 */
function sessionKeyOf(secret: Uint8Array): string {
  const secretBase64 = Buffer.from(secret).toString("base64");
  return createHash("md5").update(secretBase64, "utf8").digest("hex").substring(0, 16);
}

/** Decrypt one WuKongIM payload with the session key.
 * @param data - raw payload bytes (the server sends base64 text).
 * @param aesKey - 16-character session key.
 * @param aesIV - 16-character IV taken from the CONNACK salt.
 * @returns The decrypted plaintext bytes.
 */
/** Decrypt one WuKongIM payload with the session key.
 * @param data - raw payload bytes (the server sends base64 text).
 * @param aesKey - 16-character session key.
 * @param aesIV - 16-character IV taken from the CONNACK salt.
 * @returns The decrypted plaintext bytes.
 */
export function aesDecrypt(data: Uint8Array, aesKey: string, aesIV: string): Uint8Array {
  const ciphertext = Buffer.from(uintToString(data), "base64");
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(aesKey, "utf8"), Buffer.from(aesIV, "utf8"));
  return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** Derive the session key and IV from one DH exchange.
 *
 * Exported so the regression test can pin this against the pre-node:crypto
 * implementation: a mistake here silently breaks every inbound message.
 * @param privateKey - our X25519 private key from CONNECT.
 * @param serverKeyBase64 - raw server public key from CONNACK.
 * @param salt - CONNACK salt, used as the IV.
 * @returns The 16-character AES key and IV.
 */
export function deriveSessionCipher(privateKey: KeyObject, serverKeyBase64: string, salt: string): { aesKey: string; aesIV: string } {
  const serverPubKey = importRawPublicKey(Uint8Array.from(Buffer.from(serverKeyBase64, "base64")));
  const secret = diffieHellman({ privateKey, publicKey: serverPubKey });
  return {
    aesKey: sessionKeyOf(secret),
    aesIV: salt && salt.length > 16 ? salt.substring(0, 16) : salt,
  };
}

// ─── Packet Encoding / Decoding ─────────────────────────────────────────────

function encodeConnectPacket(opts: {
  version: number;
  deviceFlag: number;
  deviceID: string;
  uid: string;
  token: string;
  clientTimestamp: number;
  clientKey: string;
}): Uint8Array {
  const body = new Encoder();
  body.writeByte(opts.version);
  body.writeByte(opts.deviceFlag);
  body.writeString(opts.deviceID);
  body.writeString(opts.uid);
  body.writeString(opts.token);
  body.writeInt64(BigInt(opts.clientTimestamp));
  body.writeString(opts.clientKey);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  // header: packetType << 4 | flags (noPersist bit0 = hasServerVersion for CONNACK)
  frame.writeByte((PacketType.CONNECT << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

function encodePingPacket(): Uint8Array {
  return new Uint8Array([(PacketType.PING << 4) | 0]);
}

function encodeRecvackPacket(messageID: string, messageSeq: number): Uint8Array {
  const body = new Encoder();
  body.writeInt64(BigInt(messageID));
  body.writeInt32(messageSeq);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  frame.writeByte((PacketType.RECVACK << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

interface SettingFlags {
  receiptEnabled: boolean;
  topic: boolean;
  streamOn: boolean;
}

function parseSettingByte(v: number): SettingFlags {
  return {
    receiptEnabled: ((v >> 7) & 0x01) > 0,
    topic: ((v >> 3) & 0x01) > 0,
    streamOn: ((v >> 1) & 0x01) > 0,
  };
}

// ─── WKSocket — Independent WebSocket Connection ────────────────────────────

interface WKSocketOptions {
  wsUrl: string;
  uid: string;
  token: string;
  onMessage: (msg: BotMessage) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Bound on the entire connection build-up: TCP/Upgrade, then the CONNECT packet, then
 * CONNACK.
 *
 * `connected`, the ping timer and the stability timer all start only after a successful
 * CONNACK, so a build-up that stalls anywhere before that emits no close event and no
 * ping timeout — nothing else in the process would ever notice. Both halves matter: the
 * upgrade can hang in CONNECTING, and a socket can reach OPEN and then never be answered.
 */
export const CONNECT_DEADLINE_MS = 15_000;

/**
 * WuKongIM WebSocket client for bot connections.
 *
 * Implements the WuKongIM binary protocol directly over WebSocket,
 * with per-instance DH key exchange, AES encryption, heartbeat,
 * reconnect, and RECVACK.
 *
 * Each WKSocket instance maintains its own independent connection,
 * enabling multiple bot accounts to run simultaneously.
 */
export class WKSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private needReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartTimer: ReturnType<typeof setInterval> | null = null;
  private pingRetryCount = 0;
  private readonly pingMaxRetry = 3;
  private reconnectAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deadline for the whole connection build-up; see startConnectDeadline. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectTime = 0;
  private rapidDisconnectCount = 0;
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;

  // Per-instance crypto state (set after CONNACK)
  private aesKey = "";
  private aesIV = "";
  private dhPrivateKey: KeyObject | null = null;
  private serverVersion = 0;

  /** Bytes of a partially received frame, retained across chunks. */
  private tempBuffer = new Uint8Array(0);

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket and resolve after CONNACK.
   * @returns A promise for the first usable connection generation.
   */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.readyPromise !== undefined && this.needReconnect) return this.readyPromise;
    this.needReconnect = true;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.doConnect();
    return this.readyPromise;
  }

  /** Resolve the first-connection waiter exactly once.
   * @returns void.
   */
  private markReady(): void {
    const resolve = this.readyResolve;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    resolve?.();
  }

  /** Reject and clear the first-connection waiter.
   * @param error - terminal connection failure.
   * @returns void.
   */
  private rejectReady(error: Error): void {
    const reject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.readyPromise = undefined;
    reject?.(error);
  }



  /** Gracefully disconnect */
  disconnect(): void {
    this.needReconnect = false;
    this.rejectReady(new Error("octo: connection stopped before CONNACK"));
    this.connected = false;
    this.lastConnectTime = 0;
    this.rapidDisconnectCount = 0;
    this.stopHeart();
    this.clearConnectDeadline();
    this.stopReconnectTimer();
    this.clearStableTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /** Disconnect and wait for the old WS to fully close before resolving. */
  async disconnectAndWait(timeoutMs = 2000): Promise<void> {
    this.needReconnect = false;
    this.rejectReady(new Error("octo: connection stopped before CONNACK"));
    this.connected = false;
    this.stopHeart();
    this.stopReconnectTimer();
    this.clearStableTimer();
    this.clearConnectDeadline();

    const oldWs = this.ws;
    this.ws = null;
    this.lastConnectTime = 0;
    this.rapidDisconnectCount = 0;

    if (!oldWs) return;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      oldWs.on("close", done);
      try { oldWs.close(); } catch { /* ignore */ }
      setTimeout(() => {
        if (!resolved) {
          try { (oldWs as WebSocket & { terminate?: () => void }).terminate?.(); } catch { /* ignore */ }
          done();
        }
      }, timeoutMs);
    });
  }

/**
 * True only after a successful CONNACK — i.e. the connection can actually carry traffic.
 *
 * Between `open` and CONNACK the socket is OPEN but unusable, so anything that reports
 * liveness must not treat that window as connected.
 */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Arm the build-up deadline for one specific socket.
   *
   * The callback is bound to the socket that created it and guarded the same way every
   * other handler here is, so a deadline left over from an abandoned attempt can never
   * close the connection that replaced it.
   */
  private startConnectDeadline(ws: WebSocket): void {
    this.clearConnectDeadline();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws !== ws) return; // stale guard
      console.debug("[WKSocket] connect deadline expired before CONNACK, closing");
      try { ws.close(); } catch { /* ignore */ }
      // The close handler takes over from here: needReconnect is still true, so the
      // ordinary backoff schedules the next attempt.
    }, CONNECT_DEADLINE_MS);
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  // ─── Internal Connection Logic ──────────────────────────────────────────

  private doConnect(): void {
    this.clearStableTimer();
    // The socket being replaced takes its deadline with it.
    this.clearConnectDeadline();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.tempBuffer = new Uint8Array(0);
    const ws = new WebSocket(this.opts.wsUrl, { maxPayload: MAX_PACKET_BYTES, handshakeTimeout: CONNECT_DEADLINE_MS });
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.startConnectDeadline(ws);

    ws.on("open", () => {
      if (this.ws !== ws) return; // stale guard
      this.tempBuffer = new Uint8Array(0);
      // X25519 key pair from the OS CSPRNG; only the raw public half is sent.
      const keyPair = generateKeyPairSync("x25519");
      this.dhPrivateKey = keyPair.privateKey;
      const pubKey = exportRawPublicKey(keyPair.publicKey);

      const deviceID = generateDeviceID() + "W";
      const packet = encodeConnectPacket({
        version: PROTO_VERSION,
        deviceFlag: 0, // 0 = app/bot
        deviceID,
        uid: this.opts.uid,
        token: this.opts.token,
        clientTimestamp: Date.now(),
        clientKey: pubKey,
      });
      ws.send(packet);
    });

    ws.on("message", (data: ArrayBuffer | Buffer) => {
      if (this.ws !== ws) return; // stale guard
      // Buffer is already a Uint8Array view; use it directly to avoid the
      // 3-arg vs 1-arg footgun. `new Uint8Array(buffer)` without byteOffset/
      // byteLength reads the WHOLE underlying ArrayBuffer, which for a Buffer
      // that is a view (e.g. from a buffer pool) leaks adjacent memory into
      // the frame parser.
      const bytes: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      this.handleRawData(bytes);
    });

    ws.on("close", () => {
      // Ignore close events from stale WebSocket instances.
      // When onError triggers disconnect()+connect(), the old WS close event
      // fires asynchronously and must not trigger a phantom reconnect.
      if (this.ws !== ws) return;

      if (this.connected) {
        this.connected = false;
        this.opts.onDisconnected?.();
      }
      this.stopHeart();
      this.clearStableTimer();
      this.clearConnectDeadline();

      // Track rapid disconnects: if connection lasted <5s, it's unstable
      if (this.lastConnectTime > 0) {
        const duration = Date.now() - this.lastConnectTime;
        if (duration < 5000) {
          this.rapidDisconnectCount++;
        } else {
          this.rapidDisconnectCount = 0;
        }
        this.lastConnectTime = 0;
      }

      // If 3+ consecutive rapid disconnects, trigger onError for token refresh
      if (this.rapidDisconnectCount >= 3) {
        this.needReconnect = false;
        this.rapidDisconnectCount = 0;
        this.opts.onError?.(new Error("Connect failed: rapid disconnect detected"));
        return;
      }

      if (this.needReconnect) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return; // stale guard
      console.debug("[WKSocket] ws error:", err.message);
      // The 'close' event will follow, which handles reconnect
    });
  }

  private scheduleReconnect(): void {
    this.stopReconnectTimer();
    const baseDelay = 3000;
    const maxDelay = 60000;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    // Add ±25% random jitter to prevent thundering herd
    const jitter = exponentialDelay * (0.75 + Math.random() * 0.5);
    const delay = Math.floor(jitter);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      // Cleared on entry: leaving the handle set makes "a reconnect is already pending"
      // permanently true, which silences everything that consults it.
      this.reconnectTimer = null;
      if (this.needReconnect) {
        this.doConnect();
      }
    }, delay);
  }

  stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      if (this.connected) {
        this.reconnectAttempts = 0;
        this.rapidDisconnectCount = 0;
      }
    }, 30_000);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────

  private restartHeart(): void {
    this.stopHeart();
    this.pingRetryCount = 0;
    this.heartTimer = setInterval(() => {
      this.pingRetryCount++;
      if (this.pingRetryCount > this.pingMaxRetry) {
        console.debug("[WKSocket] ping timeout, reconnecting...");
        this.stopHeart();
        this.clearStableTimer();
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        if (this.connected) {
          this.connected = false;
          this.opts.onDisconnected?.();
        }
        if (this.needReconnect) {
          this.scheduleReconnect();
        }
        return;
      }
      this.sendRaw(encodePingPacket());
    }, 60_000); // 60s heartbeat interval (matches SDK default)
  }

  private stopHeart(): void {
    if (this.heartTimer) {
      clearInterval(this.heartTimer);
      this.heartTimer = null;
    }
  }

  // ─── Raw Data & Packet Framing ──────────────────────────────────────────

  private sendRaw(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

/** Parse fragmented WebSocket bytes with one bounded copy per chunk.
 * @param data - one received binary chunk.
 * @returns void; malformed input closes the current generation.
 */
  private handleRawData(data: Uint8Array): void {
    try {
      if (data.byteLength > MAX_BUFFER_BYTES || this.tempBuffer.length + data.byteLength > MAX_BUFFER_BYTES) throw new Error("octo: binary parser buffer limit exceeded");
      const merged = new Uint8Array(this.tempBuffer.length + data.byteLength);
      merged.set(this.tempBuffer, 0);
      merged.set(data, this.tempBuffer.length);
      let offset = 0;
      for (;;) {
        const consumed = this.unpackAt(merged, offset);
        if (consumed < 0) break;
        offset += consumed;
      }
      // Copy instead of subarray: a retained view would pin the merged buffer.
      this.tempBuffer = offset === 0 ? merged : merged.slice(offset);
    } catch (err) {
      console.debug("[WKSocket] decode error:", err instanceof Error ? err.message : err);
      this.tempBuffer = new Uint8Array(0);
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }
  }

/** Decode one packet starting at the given offset.
 * @param data - accumulated frame bytes.
 * @param offset - index of the candidate packet's first byte.
 * @returns Bytes consumed, or -1 while the packet is still incomplete.
 */
  private unpackAt(data: Uint8Array, offset: number): number {
    if (offset >= data.length) return -1;

    const packetType = data[offset] >> 4;
    if (packetType < PacketType.CONNECT || packetType > PacketType.DISCONNECT) throw new Error("octo: unknown packet type");

    // PING/PONG are single-byte packets
    if (packetType === PacketType.PONG) {
      this.onPong();
      return 1;
    }
    if (packetType === PacketType.PING) {
      return 1;
    }

    let pos = offset + 1;
    let remLength = 0;
    let multiplier = 1;
    let hasMore = false;
    let remLengthFull = true;

    do {
      if (pos > data.length - 1) {
        remLengthFull = false;
        break;
      }
      const digit = data[pos++];
      remLength += (digit & 127) * multiplier;
      multiplier *= 128;
      hasMore = (digit & 0x80) !== 0;
    } while (hasMore);

    if (!remLengthFull) return -1; // Incomplete frame
    if (remLength > MAX_PACKET_BYTES) throw new Error("octo: packet exceeds max payload");

    const totalLength = pos - offset + remLength;
    if (offset + totalLength > data.length) return -1; // Incomplete packet

    this.onPacket(data.subarray(offset, offset + totalLength));
    return totalLength;
  }

  // ─── Packet Handling ────────────────────────────────────────────────────

  private onPong(): void {
    this.pingRetryCount = 0;
  }

  private onPacket(data: Uint8Array): void {
    const firstByte = data[0];
    const packetType = firstByte >> 4;
    const hasServerVersion = (firstByte & 0x01) > 0;
    const noPersist = (firstByte & 0x01) > 0;
    const reddot = ((firstByte >> 1) & 0x01) > 0;

    // Skip the header and variable-length bytes to get body
    const dec = new Decoder(data);
    dec.readByte(); // header byte
    if (packetType !== PacketType.PING && packetType !== PacketType.PONG) {
      dec.readVariableLength(); // remaining length
    }

    switch (packetType) {
      case PacketType.CONNACK:
        this.onConnack(dec, hasServerVersion);
        break;
      case PacketType.RECV:
        this.onRecv(dec, noPersist, reddot);
        break;
      case PacketType.DISCONNECT:
        this.onDisconnect(dec);
        break;
      case PacketType.SENDACK:
        // We don't send messages via WS, ignore
        break;
    }
  }

  private onConnack(dec: Decoder, hasServerVersion: boolean): void {
    if (hasServerVersion) {
      this.serverVersion = dec.readByte();
    }
    const _timeDiff = dec.readInt64BigInt();
    const reasonCode = dec.readByte();
    const serverKey = dec.readString();
    const salt = dec.readString();
    if (this.serverVersion >= 4) {
      const _nodeId = dec.readInt64BigInt();
    }

    // The build-up is over however this turns out; cleared once here rather than in each
    // branch so a new rejection reason cannot forget to do it.
    this.clearConnectDeadline();

    if (reasonCode === 1) {
      // Success — derive AES key from DH shared secret
      const cipher = deriveSessionCipher(this.dhPrivateKey!, serverKey, salt);
      this.aesKey = cipher.aesKey;
      this.aesIV = cipher.aesIV;

      this.connected = true;
      this.lastConnectTime = Date.now();
      this.restartHeart();
      this.startStableTimer();
      this.markReady();
      this.opts.onConnected?.();
    } else if (reasonCode === 0) {
      // Kicked
      const error = new Error("Kicked by server");
      this.connected = false;
      this.needReconnect = false;
      this.rejectReady(error);
      if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
      this.opts.onError?.(error);
      this.opts.onDisconnected?.();
    } else {
      // Connect failed
      const error = new Error(`Connect failed: reasonCode=${reasonCode}`);
      this.connected = false;
      this.needReconnect = false;
      this.rejectReady(error);
      if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
      this.opts.onError?.(error);
    }
  }

  private onRecv(dec: Decoder, _noPersist: boolean, _reddot: boolean): void {
    const settingByte = dec.readByte();
    const setting = parseSettingByte(settingByte);
    const _msgKey = dec.readString();
    const fromUID = dec.readString();
    const channelID = dec.readString();
    const channelType = dec.readByte();
    if (this.serverVersion >= 3) {
      const _expire = dec.readInt32();
    }
    const _clientMsgNo = dec.readString();
    const messageID = dec.readInt64String();
    const messageSeq = dec.readInt32();
    const timestamp = dec.readInt32();
    if (setting.topic) {
      const _topic = dec.readString();
    }
    const encryptedPayload = dec.readRemaining();

    // Decrypt and validate before acknowledging; malformed data remains replayable.
    let payloadObj: Record<string, unknown>;
    try {
      const decryptedBytes = aesDecrypt(encryptedPayload, this.aesKey, this.aesIV);
      const payloadStr = uintToString(decryptedBytes);
      const parsed: unknown = JSON.parse(payloadStr);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("payload is not an object");
      payloadObj = parsed as Record<string, unknown>;
    } catch (err) {
      console.debug("[WKSocket] payload decrypt/parse error:", err instanceof Error ? err.message : err);
      return;
    }

    // Build MessagePayload (same shape as SDK's contentObj-based output)
    const payload: MessagePayload = {
      ...payloadObj,
      type: typeof payloadObj.type === "number" ? payloadObj.type as MessagePayload["type"] : 0 as MessagePayload["type"],
      content: typeof payloadObj.content === "string" ? payloadObj.content : undefined,
    };
    this.sendRaw(encodeRecvackPacket(messageID, messageSeq));

    const msg: BotMessage = {
      message_id: messageID,
      message_seq: messageSeq,
      from_uid: fromUID,
      channel_id: channelID,
      channel_type: channelType,
      timestamp,
      payload,
    };

    this.opts.onMessage(msg);
  }

  private onDisconnect(dec: Decoder): void {
    const reasonCode = dec.readByte();
    const _reason = dec.readString();

    this.connected = false;
    this.needReconnect = false;
    this.rejectReady(new Error("Kicked by server"));
    this.stopHeart();
    this.clearStableTimer();
    this.clearConnectDeadline();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.opts.onError?.(new Error("Kicked by server"));
    this.opts.onDisconnected?.();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Generate a stable-shape random device id without Math.random entropy.
 * @returns A UUID-shaped hexadecimal device id.
 */
function generateDeviceID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex");
}
