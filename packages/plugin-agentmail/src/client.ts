import { AgentMailClient } from "agentmail";
import { WebSocket as WsWebSocket } from "ws";
import { createLogger } from "@picco-agent/core";

const logger = createLogger("agentmail");

export interface SendInput {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

export interface ReplyInput {
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyAll?: boolean;
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

export interface ListInput {
  limit?: number;
  /**
   * Only return messages carrying all of these labels (e.g. ["unread"]).
   */
  labels?: string[];
}

export interface LabelChange {
  addLabels?: string[];
  removeLabels?: string[];
}

/**
 * Lightweight row used for list/search results.
 */
export interface MessageSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject?: string;
  preview?: string;
  timestamp: string;
  labels: string[];
}

/**
 * Full message including body, returned by `get`.
 */
export interface EmailMessage extends MessageSummary {
  text?: string;
  cc?: string[];
}

/**
 * An inbound email delivered to the listener.
 */
export interface InboundEmail {
  messageId: string;
  threadId: string;
  from: string;
  subject?: string;
  text?: string;
  timestamp: string;
}

/**
 * Everything the mail tools + listener need from AgentMail, bound to a single inbox.
 */
export interface AgentMailPort {
  send(input: SendInput): Promise<SendResult>;
  reply(messageId: string, input: ReplyInput): Promise<SendResult>;
  list(input?: ListInput): Promise<MessageSummary[]>;
  search(query: string, limit?: number): Promise<MessageSummary[]>;
  get(messageId: string): Promise<EmailMessage>;
  update(messageId: string, change: LabelChange): Promise<void>;
}

/**
 * A source of inbound emails. The websocket implementation lives below; tests inject a fake that
 * calls the handler directly.
 */
export interface EmailEventSource {
  start(onEmail: (email: InboundEmail) => Promise<void>): Promise<void>;
  stop(): void;
}

/**
 * Bind the SDK client to one inbox and expose it through AgentMailPort.
 */
export function createAgentMailPort(client: AgentMailClient, inboxId: string): AgentMailPort {
  return {
    async send(input) {
      const res = await client.inboxes.messages.send(inboxId, {
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        cc: input.cc,
        bcc: input.bcc,
      });
      return { messageId: res.messageId, threadId: res.threadId };
    },

    async reply(messageId, input) {
      const res = await client.inboxes.messages.reply(inboxId, messageId, {
        text: input.text,
        html: input.html,
        cc: input.cc,
        bcc: input.bcc,
        replyAll: input.replyAll,
      });
      return { messageId: res.messageId, threadId: res.threadId };
    },

    async list(input) {
      const res = await client.inboxes.messages.list(inboxId, {
        limit: input?.limit,
        labels: input?.labels,
      });
      return res.messages.map(toSummary);
    },

    async search(query, limit) {
      const res = await client.inboxes.messages.search(inboxId, { q: query, limit });
      return res.messages.map(toSummary);
    },

    async get(messageId) {
      const message = await client.inboxes.messages.get(inboxId, messageId);
      return {
        ...toSummary(message),
        text: message.text ?? message.extractedText,
        cc: message.cc,
      };
    },

    async update(messageId, change) {
      await client.inboxes.messages.update(inboxId, messageId, {
        addLabels: change.addLabels,
        removeLabels: change.removeLabels,
      });
    },
  };
}

/**
 * Inbound emails over AgentMail's WebSocket (outbound connection with auto-reconnect — works from a
 * machine on a local network with no inbound webhook). Only genuine `message.received` events are
 * surfaced; spam/blocked/unauthenticated variants are dropped.
 */
export function createWebsocketEmailSource(
  client: AgentMailClient,
  inboxId: string,
): EmailEventSource {
  let socket: Awaited<ReturnType<AgentMailClient["websockets"]["connect"]>> | undefined;

  return {
    async start(onEmail) {
      patchWsBinaryType();
      socket = await client.websockets.connect();

      const subscribe = () => {
        socket?.sendSubscribe({ type: "subscribe", inboxIds: [inboxId] });
        logger.log("subscribed to inbox", { inboxId });
      };

      socket.on("message", (event) => {
        if (event.type === "event" && event.eventType === "message.received") {
          const message = event.message;
          const email: InboundEmail = {
            messageId: message.messageId,
            threadId: message.threadId,
            from: message.from,
            subject: message.subject,
            text: message.text ?? message.extractedText,
            timestamp: asString(message.timestamp),
          };
          onEmail(email).catch((err) => logger.error("onEmail handler failed", err));
        }
      });
      socket.on("error", (err) => logger.error("websocket error", err));
      socket.on("close", () => logger.log("websocket closed"));
      // The SDK's socket auto-reconnects after a drop but does not replay the subscription —
      // without this, a reconnected socket is subscribed to nothing and inbound mail dies silently.
      socket.on("open", subscribe);

      await socket.waitForOpen();
      subscribe();
    },

    stop() {
      socket?.close();
      socket = undefined;
    },
  };
}

/**
 * Pull the bare address out of `Display Name <a@b.com>` or `a@b.com`.
 */
export function resolveEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1] : address).trim().toLowerCase();
}

/**
 * True if `address` is permitted by the allowlist. Entries are either a full address
 * (`you@gmail.com`) or a domain suffix (`@nominal.io`). An empty allowlist fails closed — matches
 * nothing.
 */
export function matchesAllowlist(address: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const email = resolveEmail(address);
  return allowlist.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    return normalized.startsWith("@") ? email.endsWith(normalized) : email === normalized;
  });
}

/**
 * AgentMail's reconnecting WebSocket defaults `binaryType` to the browser value "blob". Node's `ws`
 * ignores that, but `ws` throws (`Invalid binaryType: blob`) — it only accepts
 * nodebuffer/arraybuffer/ fragments. The SDK gives no hook to pass a WebSocket class, so we coerce
 * "blob" -> "nodebuffer" on the shared `ws` prototype. Safe: AgentMail sends JSON text frames, and
 * binaryType only affects binary frames.
 */
let wsPatched = false;
function patchWsBinaryType(): void {
  if (wsPatched) return;
  wsPatched = true;
  try {
    const proto = WsWebSocket?.prototype as object | undefined;
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, "binaryType");
    if (!desc?.set || !desc.get) return;
    const originalSet = desc.set;
    Object.defineProperty(proto, "binaryType", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value: string) {
        originalSet.call(this, value === "blob" ? "nodebuffer" : value);
      },
    });
  } catch (err) {
    logger.error("failed to patch ws binaryType", err);
  }
}

/**
 * Render an SDK timestamp (Date or string) as an ISO-ish string.
 */
function asString(ts: unknown): string {
  if (ts instanceof Date) return ts.toISOString();
  return String(ts ?? "");
}

/**
 * Project an SDK message onto MessageSummary. The SDK returns MessageItem (list) and Message (get);
 * both carry these fields.
 */
function toSummary(message: {
  messageId: string;
  threadId: string;
  from: string;
  to?: string[];
  subject?: string;
  preview?: string;
  timestamp: unknown;
  labels?: string[];
}): MessageSummary {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    from: message.from,
    to: message.to ?? [],
    subject: message.subject,
    preview: message.preview,
    timestamp: asString(message.timestamp),
    labels: message.labels ?? [],
  };
}
