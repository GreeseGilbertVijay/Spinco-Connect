import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules, type StyleProp, type ViewStyle } from "react-native";
import type { RTCPeerConnection } from "react-native-webrtc";

// Receives a live screen share from the dashboard. The server only relays the connection
// details; the picture and sound come straight from the sharing computer over WebRTC.

const SHARE_POLL_INTERVAL = 2_000;
const ICE_GATHER_TIMEOUT = 3_000;
const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// Loaded only when this app binary contains WebRTC. Importing it from a binary built
// without it, such as an older player or development build, crashes the whole app, so
// those keep playing their content and simply never answer a share.
const webrtc: typeof import("react-native-webrtc") | null = NativeModules.WebRTCModule != null
  ? require("react-native-webrtc") as typeof import("react-native-webrtc")
  : null;

export const screenShareSupported = webrtc !== null;

export function ShareView({ streamUrl, style }: { streamUrl: string; style: StyleProp<ViewStyle> }) {
  if (!webrtc) return null;
  const { RTCView } = webrtc;
  return <RTCView streamURL={streamUrl} objectFit="contain" zOrder={1} style={style} />;
}

type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>;
type ShareSession = { id: string; offer?: string };

// The whole answer goes back in one message, so every network candidate is gathered first.
function gatheringComplete(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function describe(reason: unknown) {
  return reason instanceof Error && reason.message ? reason.message : "Unknown error";
}

// Returns the stream URL to render while a share is live, or null.
export function useScreenShare(enabled: boolean, authenticatedFetch: AuthenticatedFetch) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const activeRef = useRef<{ sessionId: string; pc: RTCPeerConnection } | null>(null);
  // A session is answered once; a failed one is not retried until the dashboard sends a new one.
  const handledRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    active?.pc.close();
    setStreamUrl(null);
  }, []);

  const reply = useCallback((body: { sessionId: string; answer: string } | { sessionId: string; error: string }) => (
    authenticatedFetch("/api/device/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ), [authenticatedFetch]);

  const start = useCallback(async (sessionId: string, offer: string) => {
    stop();
    handledRef.current = sessionId;
    if (!webrtc) return;
    const pc = new webrtc.RTCPeerConnection({ iceServers: ICE_SERVERS });
    activeRef.current = { sessionId, pc };
    const isCurrent = () => activeRef.current?.pc === pc;
    pc.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (isCurrent() && stream && event.track?.kind === "video") setStreamUrl(stream.toURL());
    });
    pc.addEventListener("connectionstatechange", () => {
      if (isCurrent() && (pc.connectionState === "failed" || pc.connectionState === "closed")) stop();
    });
    try {
      await pc.setRemoteDescription(new webrtc.RTCSessionDescription({ type: "offer", sdp: offer }));
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheringComplete(pc);
      const answer = pc.localDescription?.sdp;
      if (!isCurrent()) return;
      if (!answer) throw new Error("No answer was created");
      await reply({ sessionId, answer });
    } catch (reason) {
      if (isCurrent()) stop();
      void reply({ sessionId, error: describe(reason).slice(0, 300) }).catch(() => undefined);
    }
  }, [reply, stop]);

  useEffect(() => {
    if (!enabled || !webrtc) {
      stop();
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await authenticatedFetch("/api/device/share");
        const { session } = await response.json() as { session: ShareSession | null };
        if (!active) return;
        if (!session) {
          if (activeRef.current) stop();
        } else if (session.id !== handledRef.current && session.offer) {
          void start(session.id, session.offer);
        } else if (activeRef.current && activeRef.current.sessionId !== session.id) {
          stop();
        }
      } catch {
        // A missed check keeps the current share; WebRTC notices a dead connection by itself.
      }
      if (active) timer = setTimeout(poll, SHARE_POLL_INTERVAL);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [authenticatedFetch, enabled, start, stop]);

  useEffect(() => stop, [stop]);

  return streamUrl;
}
