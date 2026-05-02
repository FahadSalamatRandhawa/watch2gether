'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('w2g:nickname') : '';
    if (saved) setNickname(saved);
  }, []);

  function persistNickname(value: string) {
    setNickname(value);
    try { localStorage.setItem('w2g:nickname', value); } catch {}
  }

  function createRoom() {
    setCreating(true);
    setError(null);
    const id = generateRoomId();
    try { localStorage.setItem(`w2g:created:${id}`, '1'); } catch {}
    router.push(`/r/${id}`);
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    const code = extractRoomId(joinCode);
    if (!code) {
      setError('Enter a room code or paste a room link');
      return;
    }
    router.push(`/r/${code}`);
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-4xl font-semibold tracking-tight">watch2gether</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Watch a local video file in sync with friends. No signup. Rooms auto-delete a day after everyone leaves.
          </p>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-medium">Your name</label>
          <input
            value={nickname}
            onChange={(e) => persistNickname(e.target.value)}
            placeholder="Guest"
            maxLength={32}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100"
          />
        </div>

        <div className="space-y-3">
          <button
            onClick={createRoom}
            disabled={creating}
            className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {creating ? 'Creating room…' : 'Create a room'}
          </button>

          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            <span>or join existing</span>
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>

          <form onSubmit={joinRoom} className="flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Paste room link or code"
              className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Join
            </button>
          </form>
        </div>

        {error && (
          <p className="text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <p className="text-center text-xs text-zinc-500">
          Heads up: each viewer needs their own copy of the video file. Share the link <em>and</em> the file with your friends.
        </p>
      </div>
    </div>
  );
}

function extractRoomId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/r\/([a-z0-9]+)/i);
  if (match) return match[1];
  if (/^[a-z0-9]{4,32}$/i.test(trimmed)) return trimmed;
  return null;
}

function generateRoomId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
