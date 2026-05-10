import type * as Party from 'partykit/server';

type Member = { peerId: string; nickname: string };
type VideoMeta = { name: string; size: number; durationMs: number };
type ChatMsg =
  | { id: string; kind: 'msg'; peerId: string; nickname: string; text: string; ts: number }
  | { id: string; kind: 'system'; text: string; ts: number };

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_LIMIT = 200;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export default class WatchRoom implements Party.Server {
  hostId: string | null = null;
  members = new Map<string, Member>();
  video: VideoMeta | null = null;
  chat: ChatMsg[] = [];

  constructor(readonly room: Party.Room) {}

  async onStart() {
    this.video = (await this.room.storage.get<VideoMeta | null>('video')) ?? null;
    this.chat = (await this.room.storage.get<ChatMsg[]>('chat')) ?? [];
    this.hostId = (await this.room.storage.get<string | null>('hostId')) ?? null;
  }

  async onRequest(req: Party.Request) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (req.method === 'GET') {
      const initialized = await this.room.storage.get<boolean>('initialized');
      return new Response(JSON.stringify({ exists: !!initialized }), {
        headers: { 'content-type': 'application/json', ...CORS_HEADERS },
      });
    }
    return new Response('method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const isCreator = url.searchParams.get('creator') === '1';
    const initialized = await this.room.storage.get<boolean>('initialized');

    if (!initialized && !isCreator) {
      conn.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      conn.close();
      return;
    }
    if (!initialized) {
      await this.room.storage.put('initialized', true);
    }

    // Someone's here, cancel any pending TTL alarm.
    await this.room.storage.deleteAlarm();

    const nicknameRaw = (url.searchParams.get('nickname') || '').trim();
    const nickname = (nicknameRaw || 'Guest').slice(0, 32);
    const peerId = conn.id;
    this.members.set(peerId, { peerId, nickname });

    if (!this.hostId) {
      this.hostId = peerId;
      await this.room.storage.put('hostId', this.hostId);
    }

    conn.send(JSON.stringify({
      type: 'state',
      you: { peerId, isHost: this.hostId === peerId },
      room: {
        id: this.room.id,
        video: this.video,
        chat: this.chat,
        members: this.membersList(),
        hostId: this.hostId,
      },
    }));

    this.room.broadcast(
      JSON.stringify({ type: 'member-joined', member: { peerId, nickname } }),
      [peerId],
    );
    await this.pushSystemChat(`${nickname} joined`);
    this.broadcastMembers();
  }

  async onClose(conn: Party.Connection) {
    const member = this.members.get(conn.id);
    if (!member) return;
    const wasHost = this.hostId === conn.id;
    this.members.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: 'member-left', peerId: conn.id }));
    await this.pushSystemChat(`${member.nickname} left`);

    if (this.members.size === 0) {
      // Room is temporarily empty. Keep video metadata alive so a host who
      // just had a brief disconnect can come back without losing state.
      // The TTL alarm wipes everything 24h later if nobody returns.
      this.hostId = null;
      await this.room.storage.delete('hostId');
      await this.room.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } else if (wasHost) {
      const hadVideo = !!this.video;
      this.video = null;
      await this.room.storage.delete('video');
      this.room.broadcast(JSON.stringify({ type: 'video', video: null }));
      if (hadVideo) {
        await this.pushSystemChat('Host left — stream stopped. New host picks a video to resume.');
      }
      await this.promoteHost();
    }
    this.broadcastMembers();
  }

  async onError(conn: Party.Connection) {
    await this.onClose(conn);
  }

  async onMessage(raw: string | ArrayBuffer | ArrayBufferView, sender: Party.Connection) {
    let msg: Record<string, unknown>;
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const member = this.members.get(sender.id);
    if (!member) return;
    const isHost = this.hostId === sender.id;
    const type = String(msg.type || '');

    switch (type) {
      case 'set-video': {
        if (!isHost) return;
        const video: VideoMeta = {
          name: String(msg.name || '').slice(0, 200),
          size: Number(msg.size) || 0,
          durationMs: Number(msg.durationMs) || 0,
        };
        this.video = video;
        await this.room.storage.put('video', video);
        this.room.broadcast(JSON.stringify({ type: 'video', video }));
        await this.pushSystemChat(`Now playing: ${video.name}`);
        return;
      }
      case 'signal': {
        const target = this.room.getConnection(String(msg.to || ''));
        if (!target) return;
        target.send(JSON.stringify({
          type: 'signal',
          from: sender.id,
          kind: msg.kind,
          payload: msg.payload,
        }));
        return;
      }
      case 'request-stream': {
        if (!this.hostId || this.hostId === sender.id) return;
        const host = this.room.getConnection(this.hostId);
        if (!host) return;
        host.send(JSON.stringify({ type: 'restream-request', peerId: sender.id }));
        return;
      }
      case 'claim-host': {
        if (this.hostId === sender.id) return;
        if (this.video) return;
        this.hostId = sender.id;
        await this.room.storage.put('hostId', this.hostId);
        await this.pushSystemChat(`${member.nickname} is now host`);
        this.broadcastMembers();
        return;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 1000).trim();
        if (!text) return;
        const chatMsg: ChatMsg = {
          id: newId(),
          kind: 'msg',
          peerId: sender.id,
          nickname: member.nickname,
          text,
          ts: Date.now(),
        };
        this.chat.push(chatMsg);
        this.trimChat();
        await this.room.storage.put('chat', this.chat);
        this.room.broadcast(JSON.stringify({ type: 'chat', msg: chatMsg }));
        return;
      }
    }
  }

  async onAlarm() {
    if (this.members.size > 0) return;
    await this.room.storage.deleteAll();
    this.video = null;
    this.chat = [];
    this.hostId = null;
  }

  private membersList(): Member[] {
    return [...this.members.values()];
  }

  private broadcastMembers() {
    this.room.broadcast(JSON.stringify({
      type: 'members',
      list: this.membersList(),
      hostId: this.hostId,
    }));
  }

  private async pushSystemChat(text: string) {
    const msg: ChatMsg = { id: newId(), kind: 'system', text, ts: Date.now() };
    this.chat.push(msg);
    this.trimChat();
    await this.room.storage.put('chat', this.chat);
    this.room.broadcast(JSON.stringify({ type: 'chat', msg }));
  }

  private trimChat() {
    if (this.chat.length > CHAT_LIMIT) {
      this.chat.splice(0, this.chat.length - CHAT_LIMIT);
    }
  }

  private async promoteHost() {
    if (this.hostId && this.members.has(this.hostId)) return;
    const first = this.members.values().next().value;
    this.hostId = first ? first.peerId : null;
    if (this.hostId) {
      await this.room.storage.put('hostId', this.hostId);
    } else {
      await this.room.storage.delete('hostId');
    }
    if (first) {
      await this.pushSystemChat(`${first.nickname} is now host`);
    }
  }
}

WatchRoom satisfies Party.Worker;
