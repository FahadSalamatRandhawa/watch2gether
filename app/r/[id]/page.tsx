import type { Metadata } from 'next';
import RoomClient from './RoomClient';

// Rooms are ephemeral and personal — never index them.
export const metadata: Metadata = {
  title: 'Room',
  robots: { index: false, follow: false, nocache: true },
};

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RoomClient roomId={id} />;
}
