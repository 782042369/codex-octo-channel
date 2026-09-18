/** Stable identity for one Octo conversation facet and one inbound turn.
 *
 * Key derivation follows dsh-octo-channel (Apache-2.0), which ports the
 * scheme from whoisjiahao/dsh-feishu-channel (MIT). Instead of DSH session
 * ids, a key here maps to one persistent Codex CLI thread plus one private
 * workspace directory.
 */
import { createHash, randomUUID } from "node:crypto";

/** How Octo traffic is partitioned into Codex sessions. */
export type SessionScope = "chat" | "chat-sender";

declare const conversationKeyBrand: unique symbol;

/** Encoded key for one independently routed conversation facet. */
export type ConversationKey = string & { readonly [conversationKeyBrand]: true };

/** Message identity fields used before any agent or transport work begins. */
export interface OctoChatAddress {
  /** DM: the peer user UID; group/thread: the channel id verbatim. */
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  /** 1 = DM, 2 = group, 5 = thread. */
  readonly channelType: number;
}

/** Immutable destination captured for one agent turn. */
export interface TurnTarget {
  readonly conversationKey: ConversationKey;
  readonly chatId: string;
  readonly channelType: number;
  readonly replyToMessageId: string;
  /** Reply should @-mention this sender (group chats only). */
  readonly replyMentionUid?: string | undefined;
}

/**
 * Reject empty components before they can poison a derived key.
 * @param value - one address component.
 * @param label - component name for the error message.
 * @returns The component, unchanged.
 */
function component(value: string, label: string): string {
  if (value === "") throw new Error(label + " must not be empty");
  return encodeURIComponent(value);
}

/**
 * Derive the sole state-partition key for one conversation facet. The
 * channel type is part of the key because Octo uids and group numbers are
 * drawn from unrelated id spaces and could otherwise collide.
 * @param scope - session partitioning policy.
 * @param address - inbound message identity.
 * @returns The conversation key.
 */
export function conversationKey(scope: SessionScope, address: OctoChatAddress): ConversationKey {
  const facet = address.channelType === 1 ? "dm" : address.channelType === 2 ? "group" : "thread";
  const chat = component(address.chatId, "chatId");
  if (scope === "chat-sender" && address.channelType !== 1) {
    return (facet + ":" + chat + ":sender:" + component(address.senderId, "senderId")) as ConversationKey;
  }
  return (facet + ":" + chat) as ConversationKey;
}

/**
 * Derive a filesystem-safe directory name for one conversation key.
 * Encoded keys can grow long and contain %-escapes; a short digest keeps
 * directory names bounded and portable.
 * @param key - conversation identity.
 * @returns A stable slug safe to use as a single path segment.
 */
export function workspaceSlug(key: ConversationKey): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/**
 * Create the immutable reply destination for one inbound message.
 * @param scope - session partitioning policy.
 * @param address - inbound message identity.
 * @returns A frozen turn target.
 */
export function createTurnTarget(scope: SessionScope, address: OctoChatAddress): TurnTarget {
  const replyMentionUid =
    address.channelType !== 1 && address.senderId !== "" ? address.senderId : undefined;
  return Object.freeze({
    conversationKey: conversationKey(scope, address),
    chatId: address.chatId,
    channelType: address.channelType,
    replyToMessageId: address.messageId,
    ...(replyMentionUid === undefined ? {} : { replyMentionUid }),
  });
}

/**
 * Mint a correlation id for one queued turn.
 * @returns A unique turn id string.
 */
export function createTurnId(): string {
  return "octo-turn-" + randomUUID();
}
