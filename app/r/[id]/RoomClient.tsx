'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { partyHttpUrl, partyWsUrl } from '@/lib/partykit';
import { clearHandle, loadHandle, pickVideoFile, saveHandle } from '@/lib/file-handle-store';

type Member = { peerId: string; nickname: string };
type VideoMeta = { name: string; size: number; durationMs: number };
type ChatMsg =
  | { id: string; kind: 'msg'; peerId: string; nickname: string; text: string; ts: number }
  | { id: string; kind: 'system'; text: string; ts: number };

type SignalPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type ServerMsg =
  | { type: 'state'; you: { peerId: string; isHost: boolean }; room: {
      id: string; video: VideoMeta | null;
      chat: ChatMsg[]; members: Member[]; hostId: string | null;
    } }
  | { type: 'video'; video: VideoMeta | null }
  | { type: 'chat'; msg: ChatMsg }
  | { type: 'members'; list: Member[]; hostId: string | null }
  | { type: 'member-joined'; member: Member }
  | { type: 'member-left'; peerId: string }
  | { type: 'signal'; from: string; kind: 'offer' | 'answer' | 'ice'; payload: SignalPayload }
  | { type: 'restream-request'; peerId: string }
  | { type: 'error'; message: string };

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// Tuning for movie viewing: prefer crisp picture over real-time latency.
const VIDEO_MAX_BITRATE = 8_000_000; // 8 Mbps ceiling; WebRTC adapts down per peer.
const AUDIO_MAX_BITRATE = 128_000;   // 128 kbps Opus
const GUEST_PLAYOUT_DELAY_S = 1.5;   // 1.5s jitter buffer on guest side; absorbs more network jitter

export default function RoomClient({ roomId }: { roomId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Host: stream captured from local video element
  const localStreamRef = useRef<MediaStream | null>(null);
  // Host: one RTCPeerConnection per guest
  const hostPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Guest: single RTCPeerConnection to host
  const guestPeerRef = useRef<RTCPeerConnection | null>(null);
  // Guest: incoming stream (assigned to videoRef.srcObject)
  const guestStreamRef = useRef<MediaStream | null>(null);
  // Buffer ICE candidates received before remote description is set (guest side)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // Latest values for WS handler closures
  const youRef = useRef<{ peerId: string; isHost: boolean } | null>(null);
  const hostIdRef = useRef<string | null>(null);
  const membersRef = useRef<Member[]>([]);
  const roomVideoRef = useRef<VideoMeta | null>(null);
  const localFileRef = useRef<File | null>(null);

  const [nickname, setNickname] = useState('');
  const [nicknameSubmitted, setNicknameSubmitted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomCheck, setRoomCheck] = useState<'checking' | 'ok' | 'missing'>('checking');
  const fatalRef = useRef(false);

  const [you, setYou] = useState<{ peerId: string; isHost: boolean } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [roomVideo, setRoomVideo] = useState<VideoMeta | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Host-only
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localFileURL, setLocalFileURL] = useState<string | null>(null);
  const [savedHandle, setSavedHandle] = useState<FileSystemFileHandle | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Guest-only
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [muted, setMuted] = useState(true);
  const [guestConnState, setGuestConnState] = useState<RTCPeerConnectionState>('new');

  const isHost = !!you && you.peerId === hostId;

  // Keep refs in sync with state
  useEffect(() => { youRef.current = you; }, [you]);
  useEffect(() => { hostIdRef.current = hostId; }, [hostId]);
  useEffect(() => { membersRef.current = members; }, [members]);
  useEffect(() => { roomVideoRef.current = roomVideo; }, [roomVideo]);
  useEffect(() => { localFileRef.current = localFile; }, [localFile]);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('w2g:nickname') || '' : '';
    setNickname(saved);
    if (saved) setNicknameSubmitted(true);
  }, []);

  // Look up a previously saved file handle for this room (host-only utility).
  useEffect(() => {
    let cancelled = false;
    loadHandle(roomId)
      .then((h) => { if (!cancelled) setSavedHandle(h); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  // Pre-check that the room exists before showing the join form.
  // The creator side has a localStorage flag and skips this check.
  useEffect(() => {
    let cancelled = false;
    const isCreator = typeof window !== 'undefined'
      && localStorage.getItem(`w2g:created:${roomId}`) === '1';
    if (isCreator) {
      setRoomCheck('ok');
      return;
    }
    fetch(partyHttpUrl(roomId))
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setRoomCheck(data?.exists ? 'ok' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setRoomCheck('ok');
      });
    return () => { cancelled = true; };
  }, [roomId]);

  // Host: when localFile changes, build a fresh object URL and prepare for streaming
  useEffect(() => {
    if (!localFile) {
      setLocalFileURL(null);
      return;
    }
    const url = URL.createObjectURL(localFile);
    setLocalFileURL(url);
    return () => URL.revokeObjectURL(url);
  }, [localFile]);

  const sendWS = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  // ---- Host side: capture stream from local video and offer to guests ----

  const captureLocalStream = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    if (localStreamRef.current && localStreamRef.current.active) return localStreamRef.current;
    const captureFn = (video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    });
    const fn = captureFn.captureStream || captureFn.mozCaptureStream;
    if (!fn) {
      setError('Your browser does not support sharing this video. Try Chrome, Edge, or Firefox.');
      return null;
    }
    try {
      const stream = fn.call(video);
      localStreamRef.current = stream;
      return stream;
    } catch (e) {
      console.warn('captureStream failed', e);
      return null;
    }
  }, []);

  const preferVideoCodecs = useCallback((pc: RTCPeerConnection) => {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps) return;
    // VP9 first (best quality at constrained bitrate, hardware decode is universal),
    // then VP8 (universal fallback), then H.264, then anything else.
    const score = (mime: string): number => {
      const m = mime.toLowerCase();
      if (m === 'video/vp9') return 0;
      if (m === 'video/vp8') return 1;
      if (m === 'video/h264') return 2;
      return 3;
    };
    const sorted = [...caps.codecs].sort((a, b) => score(a.mimeType) - score(b.mimeType));
    for (const t of pc.getTransceivers()) {
      if (t.sender.track?.kind !== 'video') continue;
      try { t.setCodecPreferences(sorted); }
      catch (e) { console.warn('setCodecPreferences failed', e); }
    }
  }, []);

  const tuneSenderEncodings = useCallback(async (pc: RTCPeerConnection) => {
    for (const sender of pc.getSenders()) {
      const kind = sender.track?.kind;
      if (kind !== 'video' && kind !== 'audio') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        if (kind === 'video') {
          params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
          // Hint to the OS / QoS-aware network gear that this is real-time
          // video and should be prioritized over background traffic.
          params.encodings[0].networkPriority = 'high';
          // Movies look better at full resolution with adaptive frame rate
          // than scaled-down at full frame rate.
          params.degradationPreference = 'maintain-resolution';
        } else {
          params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
        }
        await sender.setParameters(params);
      } catch (e) {
        console.warn('tune sender failed', kind, e);
      }
    }
  }, []);

  const offerToPeer = useCallback(async (peerId: string, opts: { iceRestart?: boolean } = {}) => {
    const stream = captureLocalStream();
    if (!stream) return;
    let pc = hostPeersRef.current.get(peerId);
    const reuse = !!pc && opts.iceRestart && pc.connectionState !== 'closed';
    if (!reuse) {
      if (pc) { try { pc.close(); } catch {} }
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      hostPeersRef.current.set(peerId, pc);
      for (const track of stream.getTracks()) {
        try { pc.addTrack(track, stream); } catch (e) { console.warn('addTrack failed', e); }
      }
      preferVideoCodecs(pc);
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWS({ type: 'signal', to: peerId, kind: 'ice', payload: e.candidate.toJSON() });
        }
      };
      pc.onconnectionstatechange = () => {
        const current = hostPeersRef.current.get(peerId);
        if (current !== pc) return;
        const state = pc!.connectionState;
        if (state === 'failed') {
          // Try to recover without losing the connection: re-offer with iceRestart.
          offerToPeer(peerId, { iceRestart: true }).catch(() => {});
        } else if (state === 'closed') {
          hostPeersRef.current.delete(peerId);
        }
      };
    }
    try {
      const offer = await pc!.createOffer({ iceRestart: !!opts.iceRestart });
      await pc!.setLocalDescription(offer);
      // Apply encoding tuning AFTER local description so parameters stick.
      await tuneSenderEncodings(pc!);
      sendWS({
        type: 'signal',
        to: peerId,
        kind: 'offer',
        payload: { type: offer.type, sdp: offer.sdp },
      });
    } catch (e) {
      console.warn('offer failed', e);
    }
  }, [captureLocalStream, sendWS, tuneSenderEncodings, preferVideoCodecs]);

  const offerToAllGuests = useCallback(() => {
    const me = youRef.current?.peerId;
    for (const m of membersRef.current) {
      if (m.peerId === me) continue;
      offerToPeer(m.peerId);
    }
  }, [offerToPeer]);

  const tearDownHostPeers = useCallback(() => {
    for (const pc of hostPeersRef.current.values()) {
      try { pc.close(); } catch {}
    }
    hostPeersRef.current.clear();
    if (localStreamRef.current) {
      // stream tracks belong to the video element; don't stop them, just drop the ref
      localStreamRef.current = null;
    }
  }, []);

  // ---- Guest side: receive stream from host ----

  const tuneGuestReceivers = useCallback((pc: RTCPeerConnection) => {
    for (const receiver of pc.getReceivers()) {
      try {
        // Increase playout delay on the guest so jitter is absorbed before display.
        // Trades ~1s latency for visibly smoother playback. Chromium-only; harmless elsewhere.
        (receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint = GUEST_PLAYOUT_DELAY_S;
      } catch {}
    }
  }, []);

  const ensureGuestPeer = useCallback(() => {
    let pc = guestPeerRef.current;
    if (pc && (pc.connectionState === 'closed' || pc.connectionState === 'failed')) {
      try { pc.close(); } catch {}
      pc = null;
    }
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    guestPeerRef.current = pc;
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      guestStreamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        v.play().catch(() => {
          v.muted = true;
          setMuted(true);
          v.play().catch(() => {});
        });
      }
      setHasRemoteStream(true);
      tuneGuestReceivers(pc!);
    };
    pc.onicecandidate = (e) => {
      const host = hostIdRef.current;
      if (!host) return;
      if (e.candidate) {
        sendWS({ type: 'signal', to: host, kind: 'ice', payload: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (guestPeerRef.current !== pc) return;
      const state = pc!.connectionState;
      setGuestConnState(state);
      if (state === 'failed') {
        // Connection died but the WS may still be alive — ask the host to re-offer.
        try { pc!.close(); } catch {}
        guestPeerRef.current = null;
        guestStreamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setHasRemoteStream(false);
        sendWS({ type: 'request-stream' });
      } else if (state === 'closed') {
        if (videoRef.current) videoRef.current.srcObject = null;
        guestStreamRef.current = null;
        setHasRemoteStream(false);
      }
    };
    return pc;
  }, [sendWS, tuneGuestReceivers]);

  const tearDownGuestPeer = useCallback(() => {
    const pc = guestPeerRef.current;
    if (pc) {
      try { pc.close(); } catch {}
      guestPeerRef.current = null;
    }
    guestStreamRef.current = null;
    pendingIceRef.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasRemoteStream(false);
  }, []);

  // ---- Signal dispatch ----

  const handleSignal = useCallback(async (msg: Extract<ServerMsg, { type: 'signal' }>) => {
    const me = youRef.current;
    if (!me) return;
    const isMeHost = me.peerId === hostIdRef.current;
    if (msg.kind === 'offer') {
      // I'm a guest receiving an offer from host
      const pc = ensureGuestPeer();
      try {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        // Drain buffered ICE
        for (const cand of pendingIceRef.current) {
          try { await pc.addIceCandidate(cand); } catch {}
        }
        pendingIceRef.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWS({
          type: 'signal',
          to: msg.from,
          kind: 'answer',
          payload: { type: answer.type, sdp: answer.sdp },
        });
      } catch (e) {
        console.warn('offer handling failed', e);
      }
      return;
    }
    if (msg.kind === 'answer') {
      // I'm host, getting answer from a guest
      if (!isMeHost) return;
      const pc = hostPeersRef.current.get(msg.from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      } catch (e) {
        console.warn('answer handling failed', e);
      }
      return;
    }
    if (msg.kind === 'ice') {
      const cand = msg.payload as RTCIceCandidateInit;
      if (isMeHost) {
        const pc = hostPeersRef.current.get(msg.from);
        if (!pc) return;
        try { await pc.addIceCandidate(cand); } catch (e) { console.warn(e); }
      } else {
        const pc = guestPeerRef.current;
        if (!pc || !pc.remoteDescription) {
          pendingIceRef.current.push(cand);
          return;
        }
        try { await pc.addIceCandidate(cand); } catch (e) { console.warn(e); }
      }
    }
  }, [ensureGuestPeer, sendWS]);

  // ---- WebSocket lifecycle ----

  useEffect(() => {
    if (!nicknameSubmitted) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function open() {
      if (cancelled) return;
      const params: Record<string, string> = { nickname: nickname || 'Guest' };
      if (typeof window !== 'undefined' && localStorage.getItem(`w2g:created:${roomId}`) === '1') {
        params.creator = '1';
      }
      const url = partyWsUrl(roomId, params);
      setConnecting(true);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setConnecting(false);
        setError(null);
      };

      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.type) {
          case 'state': {
            setYou(msg.you);
            youRef.current = msg.you;
            setMembers(msg.room.members);
            membersRef.current = msg.room.members;
            setHostId(msg.room.hostId);
            hostIdRef.current = msg.room.hostId;
            setRoomVideo(msg.room.video);
            roomVideoRef.current = msg.room.video;
            setChat(msg.room.chat);

            // Reconnect recovery: if I'm host and already have an active stream,
            // re-publish video metadata and re-offer to every other peer. Handles
            // the case where the WS dropped briefly while I was streaming.
            const meIsHost = msg.you.peerId === msg.room.hostId;
            const stream = localStreamRef.current;
            if (meIsHost && stream && stream.active) {
              const v = videoRef.current;
              const f = localFileRef.current;
              if (v && f) {
                sendWS({
                  type: 'set-video',
                  name: f.name,
                  size: f.size,
                  durationMs: Math.round((v.duration || 0) * 1000),
                });
              }
              for (const m of msg.room.members) {
                if (m.peerId !== msg.you.peerId) offerToPeer(m.peerId);
              }
            }
            break;
          }
          case 'video':
            setRoomVideo(msg.video);
            roomVideoRef.current = msg.video;
            // If video cleared (host left or new host), tear down guest stream
            if (!msg.video) {
              tearDownGuestPeer();
            }
            break;
          case 'members':
            setMembers(msg.list);
            membersRef.current = msg.list;
            setHostId(msg.hostId);
            hostIdRef.current = msg.hostId;
            break;
          case 'member-joined': {
            // If I'm host and have a stream ready, offer to the new member
            const me = youRef.current;
            const stream = localStreamRef.current;
            if (me && me.peerId === hostIdRef.current && stream && stream.active) {
              offerToPeer(msg.member.peerId);
            }
            break;
          }
          case 'member-left': {
            const me = youRef.current;
            if (me && me.peerId === hostIdRef.current) {
              const pc = hostPeersRef.current.get(msg.peerId);
              if (pc) { try { pc.close(); } catch {} ; hostPeersRef.current.delete(msg.peerId); }
            }
            break;
          }
          case 'restream-request': {
            // Guest asked for a fresh offer (likely after a WebRTC failure).
            const me = youRef.current;
            const stream = localStreamRef.current;
            if (me && me.peerId === hostIdRef.current && stream && stream.active) {
              offerToPeer(msg.peerId);
            }
            break;
          }
          case 'signal':
            handleSignal(msg);
            break;
          case 'chat':
            setChat((prev) => [...prev, msg.msg].slice(-200));
            break;
          case 'error':
            fatalRef.current = true;
            setError(msg.message);
            if (msg.message === 'Room not found') setRoomCheck('missing');
            try { ws.close(); } catch {}
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (cancelled || fatalRef.current) return;
        setConnecting(false);
        retryTimer = setTimeout(open, 2000);
      };

      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    }

    open();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try { ws.close(); } catch {}
        wsRef.current = null;
      }
      tearDownHostPeers();
      tearDownGuestPeer();
    };
  }, [nicknameSubmitted, roomId, nickname, handleSignal, offerToPeer, tearDownGuestPeer, tearDownHostPeers]);

  // Auto-scroll the chat container only — using scrollTop so the page itself
  // never scrolls. If the user has scrolled up to read history, leave them be.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.length]);

  // ---- Handlers ----

  function handleSubmitNickname(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nickname.trim() || 'Guest';
    setNickname(trimmed);
    try { localStorage.setItem('w2g:nickname', trimmed); } catch {}
    setNicknameSubmitted(true);
  }

  async function handlePickFile() {
    setPickError(null);
    try {
      const { file, handle } = await pickVideoFile();
      tearDownHostPeers();
      setLocalFile(file);
      if (handle) {
        try { await saveHandle(roomId, handle); setSavedHandle(handle); } catch {}
      }
    } catch (err) {
      // User cancelled or browser denied — silent unless it's a real error
      if (err instanceof Error && err.message !== 'cancelled' && err.name !== 'AbortError') {
        setPickError(err.message);
      }
    }
  }

  async function handleResumeFile() {
    if (!savedHandle) return;
    setPickError(null);
    try {
      const perm = savedHandle.requestPermission
        ? await savedHandle.requestPermission({ mode: 'read' })
        : 'granted';
      if (perm !== 'granted') {
        setPickError('Permission denied. Pick the file manually instead.');
        return;
      }
      const file = await savedHandle.getFile();
      tearDownHostPeers();
      setLocalFile(file);
    } catch (err) {
      // File was moved/deleted/renamed — drop the stale handle
      try { await clearHandle(roomId); } catch {}
      setSavedHandle(null);
      setPickError(err instanceof Error ? err.message : 'Could not re-open the file. Pick it manually.');
    }
  }

  function onHostVideoCanPlay() {
    if (!isHost) return;
    if (!localFile) return;
    const stream = captureLocalStream();
    if (!stream) return;
    const video = videoRef.current;
    const durationMs = video ? Math.round((video.duration || 0) * 1000) : 0;
    sendWS({
      type: 'set-video',
      name: localFile.name,
      size: localFile.size,
      durationMs,
    });
    offerToAllGuests();
  }

  function copyLink() {
    if (typeof window === 'undefined') return;
    navigator.clipboard.writeText(window.location.href).then(
      () => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); },
      () => {}
    );
  }

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    sendWS({ type: 'chat', text });
    setChatDraft('');
  }

  function unmuteGuest() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    setMuted(false);
    v.play().catch(() => {});
  }

  if (roomCheck === 'checking') {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="text-sm text-zinc-500">Looking up room…</p>
      </div>
    );
  }

  if (roomCheck === 'missing') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Room not found</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The room <span className="font-mono">{roomId}</span> doesn&apos;t exist or has expired.
            Rooms are deleted a day after everyone leaves.
          </p>
          <div className="flex flex-col gap-2">
            <a
              href="/"
              className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Go home
            </a>
            <p className="text-xs text-zinc-500">
              Or ask whoever sent you this link to create a new room.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!nicknameSubmitted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <form onSubmit={handleSubmitNickname} className="w-full max-w-sm space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">Join room</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Room code: <span className="font-mono">{roomId}</span>
          </p>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Your name"
            maxLength={32}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100"
            autoFocus
          />
          <button
            type="submit"
            className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Continue
          </button>
        </form>
      </div>
    );
  }

  // Host needs to pick a file before video can render
  const hostNeedsFile = isHost && !localFileURL;
  // Guest waiting for host to start
  const guestWaiting = !isHost && (!roomVideo || !hasRemoteStream);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <main className="flex shrink-0 flex-col gap-3 p-3 sm:p-4 lg:min-h-0 lg:flex-1 lg:shrink lg:overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : connecting ? 'bg-amber-500' : 'bg-red-500'}`} />
            <span className="text-zinc-600 dark:text-zinc-400">
              {connected ? `Room ${roomId}` : connecting ? 'Connecting…' : 'Disconnected'}
            </span>
            {isHost && <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-white dark:bg-zinc-100 dark:text-zinc-900">Host</span>}
          </div>
          <button
            onClick={copyLink}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {linkCopied ? 'Copied!' : 'Copy invite link'}
          </button>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          {isHost ? (
            localFileURL ? (
              <video
                ref={videoRef}
                src={localFileURL}
                controls
                playsInline
                className="h-full w-full"
                onCanPlay={onHostVideoCanPlay}
              />
            ) : (
              <HostFilePicker
                onPick={handlePickFile}
                savedHandle={savedHandle}
                onResume={handleResumeFile}
              />
            )
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={muted}
                controls={hasRemoteStream}
                className={`h-full w-full ${hasRemoteStream ? '' : 'opacity-0'}`}
              />
              {guestWaiting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-zinc-300">
                  {!roomVideo ? (
                    <>
                      <span className="text-base font-medium text-white">Waiting for the host to pick a video…</span>
                      <span className="text-xs text-zinc-400">You&apos;ll start watching automatically.</span>
                      <button
                        onClick={() => sendWS({ type: 'claim-host' })}
                        className="mt-3 rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                      >
                        Take over hosting
                      </button>
                    </>
                  ) : guestConnState === 'failed' ? (
                    <>
                      <span className="text-base font-medium text-white">Reconnecting…</span>
                      <span className="mt-1 text-xs text-zinc-400">Network hiccup. Asking the host to resume.</span>
                    </>
                  ) : (
                    <>
                      <span className="text-base font-medium text-white">Connecting to host…</span>
                      <span className="mt-1 text-xs text-zinc-400">{roomVideo.name}</span>
                    </>
                  )}
                </div>
              )}
              {hasRemoteStream && guestConnState === 'disconnected' && (
                <div className="absolute right-2 top-2 rounded-full bg-amber-500/90 px-2 py-1 text-xs text-white shadow">
                  Connection unstable
                </div>
              )}
              {hasRemoteStream && muted && (
                <button
                  onClick={unmuteGuest}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-zinc-900 shadow hover:bg-white"
                >
                  Tap to unmute
                </button>
              )}
            </>
          )}
        </div>

        {hostNeedsFile && (
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            {members.length > 1
              ? `Pick a video file to start streaming. ${members.length - 1} ${members.length === 2 ? 'person is' : 'people are'} waiting.`
              : 'Pick a video file. As host, your playback streams to everyone in the room — they don’t need their own copy.'}
          </p>
        )}

        {isHost && localFileURL && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <span>
              Streaming <span className="font-medium text-zinc-900 dark:text-zinc-100">{localFile?.name}</span>
              <span className="ml-2 text-xs italic">to {Math.max(0, members.length - 1)} viewer{members.length === 2 ? '' : 's'}</span>
            </span>
            <button
              onClick={() => { tearDownHostPeers(); setLocalFile(null); }}
              className="text-xs underline-offset-2 hover:underline"
            >
              Change file
            </button>
          </div>
        )}

        {pickError && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {pickError}
          </p>
        )}

        <MembersList members={members} hostId={hostId} youId={you?.peerId ?? null} />
        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
      </main>

      <aside className="flex min-h-0 flex-1 flex-col border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 lg:w-80 lg:flex-initial lg:border-l lg:border-t-0">
        <div className="shrink-0 border-b border-zinc-200 px-4 py-3 text-sm font-medium dark:border-zinc-800">Chat</div>
        <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          {chat.length === 0 && (
            <p className="text-xs text-zinc-500">No messages yet. Say hi.</p>
          )}
          <ul className="space-y-2">
            {chat.map((m) => (
              <li key={m.id}>
                {m.kind === 'system' ? (
                  <p className="text-xs italic text-zinc-500">{m.text}</p>
                ) : (
                  <div>
                    <div className="flex items-baseline gap-1.5">
                      <span
                        className="text-sm font-semibold"
                        style={{ color: nameColor(m.peerId, m.peerId === you?.peerId) }}
                      >
                        {m.nickname}
                      </span>
                      {m.peerId === hostId && (
                        <span className="rounded bg-emerald-600 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-white">
                          host
                        </span>
                      )}
                      {m.peerId === you?.peerId && (
                        <span className="text-[10px] uppercase tracking-wide text-zinc-500">you</span>
                      )}
                    </div>
                    <div className="break-words whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
                      {m.text}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
        <form onSubmit={sendChat} className="flex shrink-0 gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <input
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            placeholder="Message…"
            maxLength={1000}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100"
            disabled={!connected}
          />
          <button
            type="submit"
            disabled={!connected || !chatDraft.trim()}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Send
          </button>
        </form>
      </aside>
    </div>
  );
}

function HostFilePicker({
  onPick,
  savedHandle,
  onResume,
}: {
  onPick: () => void;
  savedHandle: FileSystemFileHandle | null;
  onResume: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      {savedHandle && (
        <button
          onClick={onResume}
          className="rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-emerald-500"
        >
          Resume streaming <span className="font-mono">{savedHandle.name}</span>
        </button>
      )}
      <button
        onClick={onPick}
        className="rounded-md border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
      >
        {savedHandle ? 'Pick a different file' : 'Pick a video file from this device'}
      </button>
      <span className="max-w-sm text-xs text-zinc-400">
        As host, your playback streams to everyone in the room.
      </span>
    </div>
  );
}

function nameColor(peerId: string, isSelf: boolean): string {
  if (isSelf) return 'var(--w2g-self, #fbbf24)'; // amber for "you"
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 70% 60%)`;
}

function MembersList({ members, hostId, youId }: { members: Member[]; hostId: string | null; youId: string | null }) {
  if (members.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
      <span className="font-medium">In room ({members.length}):</span>
      {members.map((m) => (
        <span
          key={m.peerId}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-800"
        >
          <span className={m.peerId === youId ? 'font-semibold text-zinc-900 dark:text-zinc-100' : ''}>{m.nickname}</span>
          {m.peerId === hostId && <span className="text-[10px] uppercase text-emerald-600 dark:text-emerald-400">host</span>}
          {m.peerId === youId && <span className="text-[10px] text-zinc-500">(you)</span>}
        </span>
      ))}
    </div>
  );
}
