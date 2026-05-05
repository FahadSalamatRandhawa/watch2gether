import { ImageResponse } from "next/og";

export const alt = "watch2gether — Watch local video files together, in sync";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background:
            "radial-gradient(at 20% 20%, #18181b 0%, #09090b 60%, #000 100%)",
          color: "white",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 80,
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: -4,
            lineHeight: 1,
          }}
        >
          watch2gether
        </div>
        <div
          style={{
            marginTop: 32,
            fontSize: 40,
            color: "#a1a1aa",
            fontWeight: 400,
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.3,
          }}
        >
          Watch a local video file together with friends — peer-to-peer,
          synced, with chat.
        </div>
        <div
          style={{
            marginTop: 56,
            fontSize: 24,
            color: "#71717a",
            display: "flex",
            gap: 24,
          }}
        >
          <span>No signup</span>
          <span>·</span>
          <span>WebRTC</span>
          <span>·</span>
          <span>Auto-deletes after 1 day</span>
        </div>
      </div>
    ),
    size,
  );
}
