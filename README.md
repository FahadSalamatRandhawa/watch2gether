# watch2gether

Stream a local video file from one host to friends over WebRTC, with chat. No signup. Rooms auto-delete a day after everyone leaves.

## Architecture

- **Vercel** hosts the Next.js frontend (the pages users open in their browser).
- **PartyKit** hosts the realtime backend: WebSocket connections, room state, chat, WebRTC signaling.
- **Browsers** stream video directly to each other over WebRTC. The server only ferries small JSON messages.

## Run locally

```bash
pnpm install
pnpm dev
```

This runs Next.js on http://localhost:3000 and PartyKit on http://localhost:1999 in parallel. Open the app at http://localhost:3000.

## Deploy

Two services, both free-tier, neither asks for a credit card.

### 1. Deploy the PartyKit backend

```bash
npx partykit login        # opens browser to sign in (GitHub/Google)
pnpm deploy:party         # publishes party/server.ts
```

The CLI prints a URL like `https://watch2gether.<your-username>.partykit.dev`. Copy the host (without `https://`).

### 2. Deploy the Next.js frontend on Vercel

1. Push the repo to GitHub.
2. Import the repo on https://vercel.com/new.
3. In the project's **Settings → Environment Variables**, add:
   - **Name**: `NEXT_PUBLIC_PARTYKIT_HOST`
   - **Value**: `watch2gether.<your-username>.partykit.dev`
4. Redeploy.

Done. Open the Vercel URL, create a room, share the link.

To update the backend later: edit `party/server.ts`, run `pnpm deploy:party`. To update the frontend: push to GitHub; Vercel auto-deploys.
