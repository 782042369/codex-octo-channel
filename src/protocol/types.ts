/**
 * Octo Bot API wire types.
 *
 * Ported (trimmed) from Mininglamp-OSS/openclaw-channel-octo (Apache-2.0);
 * see NOTICE. Only the fields the dsh-octo-channel MVP consumes are kept.
 */

/** Response of POST /v1/bot/register. */
export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}

/** One precise @mention position (UTF-16 code units). */
export interface MentionEntity {
  uid: string;
  /** Start offset of the @name span in content, including the @ sign. */
  offset: number;
  /** Full length of the @name span, including the @ sign. */
  length: number;
}

export interface MentionPayload {
  uids?: string[];
  entities?: MentionEntity[];
  /** Legacy "@all" flag (true or 1). */
  all?: boolean | number;
  /** Three-state mention: humans=1 -> "@所有人". */
  humans?: boolean | number;
  /** Three-state mention: ais=1 -> "@所有AI". */
  ais?: boolean | number;
}

export interface ReplyPayload {
  payload?: MessagePayload;
  from_uid?: string;
  from_name?: string;
}

/** Inbound/outbound message body. */
export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
  name?: string;
  mention?: MentionPayload;
  reply?: ReplyPayload;
  [key: string]: unknown;
}

/** One message delivered over the WuKongIM WebSocket. */
export interface BotMessage {
  /** Snowflake id as a decimal string (int64 precision protection). */
  message_id: string;
  message_seq: number;
  from_uid: string;
  /** Absent on DM events; group_no for groups, group_no____short_id for threads. */
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
}

export interface SendMessageResult {
  message_id: string;
  client_msg_no: string;
  message_seq: number;
}

/** Channel types. */
export const enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5,
}

/** Message content types. */
export const enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
  /** Rich text (text + image blocks). */
  RichText = 14,
  /** Interactive card (Adaptive Cards 1.5 subset). */
  InteractiveCard = 17,
}

/** One entry of the bot events queue (POST /v1/bot/events). */
export interface BotEvent {
  event_id: number;
  event_type?: string;
  event_data?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** RichText(=14) block. */
export interface RichTextBlock {
  type: string;
  text?: string;
  url?: string;
  width?: number;
  height?: number;
  size?: number;
  name?: string;
}

/** Minimal logger sink. */
export type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};
