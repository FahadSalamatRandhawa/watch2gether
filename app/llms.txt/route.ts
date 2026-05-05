function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000')
  );
}

export function GET() {
  const base = siteUrl();
  const body = `# watch2gether

> Free, no-signup watch-party app. Stream a local video file from your device to friends, peer-to-peer, with built-in chat. Works on phone and desktop.

watch2gether is a browser-based watch-party tool. The host picks a local video file; their browser captures playback as a MediaStream and sends it directly to each guest over WebRTC. The server only relays small JSON messages (chat, member presence, WebRTC signaling) — no video data passes through the server. Rooms auto-delete 24 hours after the last person leaves.

## Key features

- No signup or login required
- Local video files stream peer-to-peer via WebRTC
- Host controls playback (play, pause, seek) with native video controls; guests follow automatically
- Built-in real-time chat with named participants
- Mobile-responsive: works in any modern desktop or mobile browser
- Rooms auto-expire 24 hours after the last person leaves
- VP9 codec preferred for sharper picture at constrained bitrates; falls back to VP8/H.264
- Adaptive bitrate up to 8 Mbps for video, 128 kbps Opus for audio
- Optional file-handle persistence (Chrome/Edge) so the host can resume streaming after a page reload

## How it works

1. Anyone clicks "Create a room" — a random room ID is generated client-side and the URL becomes shareable.
2. Other people open the link, type a nickname, and join.
3. The host picks a local video file. Their <video> element plays it normally with native controls.
4. The host's browser calls captureStream() on that <video>, takes the resulting MediaStream, and adds its tracks to a fresh RTCPeerConnection per guest.
5. SDP offers/answers and ICE candidates are relayed through a WebSocket signaling backend.
6. Once connected, video and audio frames flow directly between browsers — the server is no longer involved with media.
7. Whatever the host does (play, pause, scrub) the guests see automatically, because they're literally receiving the host's decoded frames.

## Pages

- [Home](${base}/): Create a new room or join an existing one via a shared link

## Technology

- Frontend: Next.js 16 (App Router), React 19, Tailwind CSS v4, deployed on Vercel
- Real-time backend: PartyKit (WebSocket + Cloudflare Durable Object per room)
- Streaming: WebRTC peer-to-peer with STUN traversal
- Storage: room state lives in the Durable Object; chat history capped at 200 messages per room

## Privacy

- No accounts, no email, no tracking pixels.
- Video and audio data never touch our server — it goes browser-to-browser.
- The only persistent data is the room metadata (member nicknames, chat history, video filename) which is wiped 24 hours after the room empties.
`;
  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
