import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as FileSystem from "expo-file-system/legacy";
import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as SplashScreen from "expo-splash-screen";
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "https://nodejs-1662913-6770471.cloudwaysnodeapps.com").replace(/\/+$/, "");
const DEVICE_TOKEN_KEY = "spinco.device-token";
const PAIRING_CODE_KEY = "spinco.pairing-code";
const CACHE_KEY = "spinco.cached-assignment";
const POLL_INTERVAL = 7_000;
const HEARTBEAT_INTERVAL = 10_000;
const SPLASH_DURATION = 2_000;
const PAIRING_RETRY_INTERVAL = 60_000;
const DEFAULT_SLIDE_SECONDS = 10;
const SLIDE_CLOCK_CHECK_INTERVAL = 250;
const MEDIA_FILE_PREFIX = "spinco-";
const IMAGE_RENDER_TIMEOUT = 20_000;
const MIN_DOWNLOAD_TIMEOUT = 20_000;
const MIN_DOWNLOAD_BYTES_PER_MS = 256;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

type Assignment = {
  id: string;
  version: number;
  url: string;
  fit: "contain" | "cover";
  mimeType: string;
  size?: number;
};

type CachedAssignment = Assignment & { uri: string };
type Slideshow = {
  version: number;
  intervalSeconds: number;
  fit: "contain" | "cover";
  slides: CachedAssignment[];
};
type PairingResponse = { code: string; expiresAt: string };
type PlayerStatus = "starting" | "pairing" | "loading" | "playing" | "offline";

async function loadCachedAssignment(): Promise<CachedAssignment | null> {
  const raw = await SecureStore.getItemAsync(CACHE_KEY);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as CachedAssignment;
    const info = await FileSystem.getInfoAsync(cached.uri);
    return info.exists ? cached : null;
  } catch {
    return null;
  }
}

function slideshowCachePath() {
  return `${FileSystem.documentDirectory}${MEDIA_FILE_PREFIX}slideshow.json`;
}

// Kept in a file because a full slideshow can exceed what SecureStore holds comfortably.
async function loadCachedSlideshow(): Promise<Slideshow | null> {
  try {
    const cached = JSON.parse(await FileSystem.readAsStringAsync(slideshowCachePath())) as Slideshow;
    const files = await Promise.all(cached.slides.map((slide) => FileSystem.getInfoAsync(slide.uri)));
    return files.every((file) => file.exists) ? cached : null;
  } catch {
    return null;
  }
}

function mediaFilePath(media: Assignment, name: string) {
  const extension = EXTENSIONS[media.mimeType] ?? "jpg";
  return `${FileSystem.documentDirectory}${MEDIA_FILE_PREFIX}${name}.${extension}`;
}

async function downloadMedia(media: Assignment, token: string, target: string) {
  const temporary = `${target}.part`;
  try {
    await FileSystem.deleteAsync(temporary, { idempotent: true });
    await File.downloadFileAsync(`${API_URL}${media.url}`, new File(temporary), {
      headers: { Authorization: `Bearer ${token}` },
      idempotent: true,
      signal: AbortSignal.timeout(MIN_DOWNLOAD_TIMEOUT + (media.size ?? 0) / MIN_DOWNLOAD_BYTES_PER_MS),
    });
    const info = await FileSystem.getInfoAsync(temporary);
    if (!info.exists || !info.size) throw new Error("The downloaded file is empty");
    await FileSystem.deleteAsync(target, { idempotent: true });
    await FileSystem.moveAsync({ from: temporary, to: target });
  } catch (reason) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    throw reason;
  }
}

// Sweeps by prefix so downloads that were still in progress are removed too.
async function removeAllMedia() {
  const directory = FileSystem.documentDirectory;
  if (!directory) return;
  const names = await FileSystem.readDirectoryAsync(directory);
  await Promise.all(names
    .filter((name) => name.startsWith(MEDIA_FILE_PREFIX))
    .map((name) => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true })));
}

function isVideo(media: Assignment) {
  return media.mimeType.startsWith("video/");
}

function describeError(reason: unknown) {
  return reason instanceof Error && reason.message ? reason.message : "Unknown error";
}

function VideoLayer({ media, fit, onReady, onError }: {
  media: CachedAssignment;
  fit: "contain" | "cover";
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const player = useVideoPlayer({ uri: media.uri }, (created) => {
    created.loop = true;
    created.play();
  });
  useEventListener(player, "statusChange", ({ status, error }) => {
    if (status === "readyToPlay") onReady();
    if (status === "error") onError(error?.message ?? "The video could not be played");
  });
  return <VideoView player={player} contentFit={fit} nativeControls={false} style={styles.fullscreen} />;
}

function slideSlot(intervalSeconds: number) {
  return Math.floor(Date.now() / (intervalSeconds * 1_000));
}

// The next slide stays mounted almost invisibly so it is already decoded when its turn comes.
function SlideshowLayer({ slideshow, fit, onShown, onError }: {
  slideshow: Slideshow;
  fit: "contain" | "cover";
  onShown: (slide: CachedAssignment) => void;
  onError: (message: string) => void;
}) {
  const { slides, intervalSeconds } = slideshow;
  // Derived from the clock, not a counter, so TVs showing the same slideshow change slides together.
  const [slot, setSlot] = useState(() => slideSlot(intervalSeconds));
  useEffect(() => {
    const timer = setInterval(() => setSlot(slideSlot(intervalSeconds)), SLIDE_CLOCK_CHECK_INTERVAL);
    return () => clearInterval(timer);
  }, [intervalSeconds]);
  const position = slot % slides.length;
  const visible = slides[position];
  const upcoming = slides[(position + 1) % slides.length];
  return (
    <>
      {[upcoming, visible].map((slide) => (
        <Image
          key={slide.uri}
          source={{ uri: slide.uri }}
          resizeMode={fit}
          style={[styles.fullscreen, slide === upcoming && styles.candidate]}
          onLoad={() => onShown(slide)}
          onError={({ nativeEvent }) => onError(`A slide could not be displayed: ${nativeEvent.error ?? "decode failed"}`)}
        />
      ))}
    </>
  );
}

function removeLocalFile(uri: string, onError: () => void) {
  void FileSystem.deleteAsync(uri, { idempotent: true }).catch(onError);
}

export default function App() {
  const [status, setStatus] = useState<PlayerStatus>("starting");
  const [showSplash, setShowSplash] = useState(true);
  const [message, setMessage] = useState("Connecting to Spinco Connect");
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [current, setCurrent] = useState<CachedAssignment | null>(null);
  const [candidate, setCandidate] = useState<CachedAssignment | null>(null);
  const [slideshow, setSlideshow] = useState<Slideshow | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [offlinePopup, setOfflinePopup] = useState(false);
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [paired, setPaired] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const tokenRef = useRef<string | null>(null);
  const currentRef = useRef<CachedAssignment | null>(null);
  const persistedUriRef = useRef<string | null>(null);
  const candidateRef = useRef<CachedAssignment | null>(null);
  const slideshowRef = useRef<Slideshow | null>(null);
  const acknowledgedRef = useRef(new Set<string>());
  const retryMs = useRef(5_000);
  const inFlight = useRef(false);
  const reportedErrorRef = useRef<string | null>(null);
  const [pollDelayMs, setPollDelayMs] = useState(POLL_INTERVAL);

  // Clears the screen first, then the stored copies, so nothing revoked stays visible or on disk.
  const handleRevoked = useCallback(async () => {
    tokenRef.current = null;
    currentRef.current = null;
    candidateRef.current = null;
    slideshowRef.current = null;
    acknowledgedRef.current.clear();
    reportedErrorRef.current = null;
    setCurrent(null);
    setCandidate(null);
    setSlideshow(null);
    setPlayerError(null);
    setPaired(false);
    setPairing(null);
    setStatus("pairing");
    setMessage("Access to this display was revoked");
    setRevoked(true);
    await Promise.all([
      SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY),
      SecureStore.deleteItemAsync(CACHE_KEY),
      removeAllMedia(),
    ]).catch(() => undefined);
  }, []);

  const authenticatedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = tokenRef.current;
    if (!token) throw new Error("Device is not paired");
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      if (tokenRef.current === token) await handleRevoked();
      throw new Error("Device access was revoked");
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return response;
  }, [handleRevoked]);

  // Shows the problem on the TV and sends it to the dashboard, once per distinct message.
  const reportError = useCallback((message: string) => {
    const text = message.slice(0, 300);
    setPlayerError(text);
    if (reportedErrorRef.current === text) return;
    reportedErrorRef.current = text;
    void authenticatedFetch("/api/device/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }).catch(() => {
      reportedErrorRef.current = null;
    });
  }, [authenticatedFetch]);

  const clearError = useCallback(() => {
    reportedErrorRef.current = null;
    setPlayerError(null);
  }, []);

  const sendHeartbeat = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      await authenticatedFetch("/api/device/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appState: foreground ? "foreground" : "background" }),
      });
    } catch {
      setStatus((previous) => previous === "playing" ? "offline" : previous);
    }
  }, [authenticatedFetch, foreground]);

  const acknowledge = useCallback(async (image: CachedAssignment) => {
    try {
      await authenticatedFetch("/api/device/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageId: image.id, version: image.version }),
      });
      setStatus("playing");
      setMessage("Player connected");
      clearError();
      return true;
    } catch {
      if (!tokenRef.current) return false;
      setStatus("offline");
      setMessage("Content is playing from local cache. Waiting for the server.");
      return false;
    }
  }, [authenticatedFetch, clearError]);

  const acknowledgeOnce = useCallback(async (image: CachedAssignment) => {
    const key = `${image.id}:${image.version}`;
    if (acknowledgedRef.current.has(key)) return;
    acknowledgedRef.current.add(key);
    if (!(await acknowledge(image))) acknowledgedRef.current.delete(key);
  }, [acknowledge]);

  const clearSlideshow = useCallback(async () => {
    const existing = slideshowRef.current;
    if (!existing) return;
    slideshowRef.current = null;
    setSlideshow(null);
    existing.slides.forEach((slide) => removeLocalFile(slide.uri, () => setMessage("Unable to remove an outdated slide")));
    await FileSystem.deleteAsync(slideshowCachePath(), { idempotent: true }).catch(() => undefined);
  }, []);

  const clearSingleMedia = useCallback(async () => {
    if (candidateRef.current) {
      removeLocalFile(candidateRef.current.uri, () => setMessage("Unable to remove a cancelled image download"));
    }
    currentRef.current = null;
    candidateRef.current = null;
    setCurrent(null);
    setCandidate(null);
    await SecureStore.deleteItemAsync(CACHE_KEY);
  }, []);

  const promote = useCallback(async (next: CachedAssignment) => {
    currentRef.current = next;
    setCurrent(next);
    setCandidate(null);
    candidateRef.current = null;
    await clearSlideshow();
    await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(next));
  }, [clearSlideshow]);

  const acceptCandidate = useCallback(async () => {
    const next = candidateRef.current;
    if (!next) return;
    await promote(next);
    await acknowledgeOnce(next);
  }, [acknowledgeOnce, promote]);

  const rejectCandidate = useCallback((failed: CachedAssignment, reason: string) => {
    if (candidateRef.current?.uri !== failed.uri) return;
    removeLocalFile(failed.uri, () => setMessage("Unable to remove a failed download"));
    candidateRef.current = null;
    setCandidate(null);
    reportError(`The image could not be displayed: ${reason}`);
  }, [reportError]);

  const downloadAssignment = useCallback(async (assignment: Assignment) => {
    const token = tokenRef.current;
    if (!FileSystem.documentDirectory || !token) return;
    const cached = await loadCachedAssignment();
    if (tokenRef.current !== token) return;
    if (cached?.id === assignment.id && cached.version === assignment.version) {
      await clearSlideshow();
      currentRef.current = cached;
      setCurrent(cached);
      setFit(assignment.fit);
      setStatus("playing");
      return;
    }
    if (candidateRef.current?.id === assignment.id && candidateRef.current.version === assignment.version) return;

    const hasContent = !!currentRef.current || !!slideshowRef.current;
    setStatus(hasContent ? "playing" : "loading");
    setMessage("Downloading the assigned content");
    const safeId = assignment.id.replace(/[^a-zA-Z0-9_-]/g, "");
    const target = mediaFilePath(assignment, `${safeId}-${assignment.version}`);
    try {
      await downloadMedia(assignment, token, target);
      if (tokenRef.current !== token) {
        removeLocalFile(target, () => undefined);
        return;
      }
      const downloaded: CachedAssignment = { ...assignment, uri: target };
      if (candidateRef.current && candidateRef.current.uri !== target) {
        removeLocalFile(candidateRef.current.uri, () => setMessage("Unable to remove an outdated image download"));
      }
      setFit(assignment.fit);
      if (isVideo(downloaded)) {
        await promote(downloaded);
      } else {
        candidateRef.current = downloaded;
        setCandidate(downloaded);
      }
    } catch (reason) {
      if (tokenRef.current !== token) return;
      setStatus(hasContent ? "playing" : "offline");
      setMessage(hasContent ? "Keeping the previous content while retrying" : "Unable to download the assigned content");
      reportError(`Download failed: ${describeError(reason)}`);
    }
  }, [clearSlideshow, promote, reportError]);

  // Slides are stored by image id, so a reordered or extended slideshow only fetches new images.
  // The previous content stays up until every slide is on disk.
  const downloadSlideshow = useCallback(async (items: Assignment[], intervalSeconds: number, nextFit: "contain" | "cover") => {
    const token = tokenRef.current;
    if (!FileSystem.documentDirectory || !token) return;
    const version = items[0].version;
    if (slideshowRef.current?.version === version) {
      setStatus("playing");
      return;
    }
    const hasContent = !!currentRef.current || !!slideshowRef.current;
    setStatus(hasContent ? "playing" : "loading");
    setMessage("Downloading the slideshow");
    try {
      const slides: CachedAssignment[] = [];
      for (const item of items) {
        const target = mediaFilePath(item, `slide-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`);
        const info = await FileSystem.getInfoAsync(target);
        if (!info.exists) await downloadMedia(item, token, target);
        slides.push({ ...item, fit: nextFit, uri: target });
      }
      if (tokenRef.current !== token) {
        slides.forEach((slide) => removeLocalFile(slide.uri, () => undefined));
        return;
      }
      const outdated = slideshowRef.current?.slides.filter((slide) => !slides.some((next) => next.uri === slide.uri)) ?? [];
      const next: Slideshow = { version, intervalSeconds, fit: nextFit, slides };
      slideshowRef.current = next;
      setSlideshow(next);
      await clearSingleMedia();
      await FileSystem.writeAsStringAsync(slideshowCachePath(), JSON.stringify(next));
      outdated.forEach((slide) => removeLocalFile(slide.uri, () => setMessage("Unable to remove an outdated slide")));
      setStatus("playing");
    } catch (reason) {
      if (tokenRef.current !== token) return;
      setStatus(hasContent ? "playing" : "offline");
      setMessage(hasContent ? "Keeping the previous content while retrying" : "Unable to download the slideshow");
      reportError(`Download failed: ${describeError(reason)}`);
    }
  }, [clearSingleMedia, reportError]);

  const fetchConfiguration = useCallback(async () => {
    if (!tokenRef.current || inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await authenticatedFetch("/api/device/config");
      const data = await response.json() as {
        assignment: Assignment | null;
        playlist?: Assignment[];
        slideIntervalSeconds?: number;
        fit: "contain" | "cover";
      };
      retryMs.current = 5_000;
      setPollDelayMs(POLL_INTERVAL);
      const playlist = data.playlist ?? (data.assignment ? [data.assignment] : []);
      if (!playlist.length) {
        await clearSingleMedia();
        await clearSlideshow();
        clearError();
        setStatus("playing");
        setMessage("Waiting for content to be assigned");
        return;
      }
      setFit(data.fit);
      if (playlist.length > 1) {
        await downloadSlideshow(playlist, data.slideIntervalSeconds ?? DEFAULT_SLIDE_SECONDS, data.fit);
      } else {
        await downloadAssignment({ ...playlist[0], fit: data.fit });
      }
    } catch {
      if (!tokenRef.current) return;
      retryMs.current = Math.min(60_000, Math.round(retryMs.current * 1.7));
      setPollDelayMs(retryMs.current);
      setStatus("offline");
      setMessage("Unable to reach the server. Retrying automatically.");
    } finally {
      inFlight.current = false;
    }
  }, [authenticatedFetch, clearError, clearSingleMedia, clearSlideshow, downloadAssignment, downloadSlideshow]);

  const completePairing = useCallback(async (token: string) => {
    await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token);
    tokenRef.current = token;
    await SecureStore.deleteItemAsync(PAIRING_CODE_KEY);
    setRevoked(false);
    setPaired(true);
    setPairing(null);
    setStatus("loading");
    setMessage("Loading the assigned content");
    void fetchConfiguration();
  }, [fetchConfiguration]);

  const beginPairing = useCallback(async () => {
    const existing = await SecureStore.getItemAsync(PAIRING_CODE_KEY);
    if (existing) {
      try {
        const response = await fetch(`${API_URL}/api/device/pairing/status?code=${encodeURIComponent(existing)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const data = await response.json() as { token?: string; deviceId?: string; paired: boolean; expiresAt: string };
          if (data.paired && data.token && data.deviceId) {
            await completePairing(data.token);
            return;
          }
          setPairing({ code: existing, expiresAt: data.expiresAt });
          setStatus("pairing");
          return;
        }
      } catch {
        setStatus("offline");
        setMessage("Cannot reach the pairing service. Check the network and server address.");
        return;
      }
      await SecureStore.deleteItemAsync(PAIRING_CODE_KEY);
    }

    const response = await fetch(`${API_URL}/api/device/pairing`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Pairing request returned ${response.status}`);
    const result = await response.json() as PairingResponse;
    await SecureStore.setItemAsync(PAIRING_CODE_KEY, result.code);
    setPairing(result);
    setStatus("pairing");
  }, [completePairing]);

  // The native splash clips its icon to a small circle, so the branded splash is drawn here at full size.
  // Timer-based on purpose: a stalled network or storage call must never leave the screen stuck on the splash.
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => undefined);
    const timer = setTimeout(() => setShowSplash(false), SPLASH_DURATION);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    void activateKeepAwakeAsync("spinco-player");
    const subscription = AppState.addEventListener("change", (nextState) => {
      setForeground(nextState === "active");
    });
    // Cached content loads only for a paired player, and before the first server check,
    // so a revocation found at startup cannot be overwritten by a late cache read.
    void SecureStore.getItemAsync(DEVICE_TOKEN_KEY).then(async (token) => {
      tokenRef.current = token;
      if (token) {
        const [cached, cachedSlideshow] = await Promise.all([loadCachedAssignment(), loadCachedSlideshow()]);
        currentRef.current = cached;
        setCurrent(cached);
        slideshowRef.current = cachedSlideshow;
        setSlideshow(cachedSlideshow);
        if (cachedSlideshow) setFit(cachedSlideshow.fit);
        setPaired(true);
        setStatus("loading");
        setMessage("Reconnecting to the assigned screen");
        void fetchConfiguration();
      } else {
        setStatus("pairing");
        void beginPairing().catch(() => {
          setStatus("offline");
          setMessage("Cannot reach the pairing service. Check the network and server address.");
        });
      }
    });
    return () => {
      subscription.remove();
      deactivateKeepAwake("spinco-player");
    };
  }, [beginPairing, fetchConfiguration]);

  useEffect(() => {
    if (!paired) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await fetchConfiguration();
      if (active) timer = setTimeout(poll, pollDelayMs);
    };
    timer = setTimeout(poll, pollDelayMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [paired, pollDelayMs, fetchConfiguration]);

  useEffect(() => {
    if (!paired) return;
    void sendHeartbeat();
    const interval = setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL);
    return () => clearInterval(interval);
  }, [paired, sendHeartbeat, status]);

  useEffect(() => {
    if (!revoked) return;
    void beginPairing().catch(() => {
      setStatus("offline");
      setMessage("Cannot reach the pairing service. Check the network and server address.");
    });
  }, [beginPairing, revoked]);

  // An unattended TV must get a working code back by itself after a server or network outage.
  useEffect(() => {
    if (paired || pairing) return;
    const timer = setInterval(() => {
      if (!tokenRef.current) void beginPairing().catch(() => undefined);
    }, PAIRING_RETRY_INTERVAL);
    return () => clearInterval(timer);
  }, [beginPairing, paired, pairing]);

  useEffect(() => {
    const code = pairing?.code;
    if (!code) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${API_URL}/api/device/pairing/status?code=${encodeURIComponent(code)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 410) {
          await SecureStore.deleteItemAsync(PAIRING_CODE_KEY);
          setPairing(null);
          await beginPairing();
          return;
        }
        if (!response.ok) throw new Error("Pairing check failed");
        const data = await response.json() as { paired: boolean; token?: string; deviceId?: string };
        if (data.paired && data.token && data.deviceId) {
          await completePairing(data.token);
          return;
        }
      } catch {
        if (active) setMessage("Waiting for the server connection");
      }
      if (active) timeout = setTimeout(poll, 5_000);
    };
    timeout = setTimeout(poll, 1_000);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [beginPairing, completePairing, pairing?.code]);

  useEffect(() => {
    if (foreground && paired) void fetchConfiguration();
  }, [foreground, paired, fetchConfiguration]);

  // A hidden image that never fires onLoad or onError would otherwise fail silently.
  useEffect(() => {
    if (!candidate) return;
    const timer = setTimeout(() => rejectCandidate(candidate, "it did not load in time"), IMAGE_RENDER_TIMEOUT);
    return () => clearTimeout(timer);
  }, [candidate, rejectCandidate]);

  useEffect(() => {
    const previousUri = persistedUriRef.current;
    persistedUriRef.current = current?.uri ?? null;
    if (!previousUri || previousUri === current?.uri) return;
    const cleanup = setTimeout(() => {
      void FileSystem.deleteAsync(previousUri, { idempotent: true }).catch(() => {
        setMessage("Unable to remove an outdated cached image");
      });
    }, 1_000);
    return () => clearTimeout(cleanup);
  }, [current]);

  useEffect(() => {
    if (status !== "offline") setOfflinePopup(false);
  }, [status]);

  const isImageVisible = !!current || !!candidate || !!slideshow;
  const retryConnection = useCallback(() => {
    setStatus("starting");
    const operation = tokenRef.current ? fetchConfiguration() : beginPairing();
    void operation.catch(() => {
      setStatus("offline");
      setMessage("Unable to connect. Check the network and server address.");
    });
  }, [beginPairing, fetchConfiguration]);

  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      {slideshow && (
        <SlideshowLayer
          key={slideshow.version}
          slideshow={slideshow}
          fit={fit}
          onShown={(slide) => void acknowledgeOnce(slide)}
          onError={reportError}
        />
      )}
      {current && isVideo(current) && (
        <VideoLayer
          key={current.uri}
          media={current}
          fit={fit}
          onReady={() => void acknowledgeOnce(current)}
          onError={(reason) => reportError(`The video could not be played: ${reason}`)}
        />
      )}
      {current && !isVideo(current) && (
        <Image
          source={{ uri: current.uri }}
          resizeMode={fit}
          style={styles.fullscreen}
          onError={({ nativeEvent }) => reportError(`The image could not be displayed: ${nativeEvent.error ?? "decode failed"}`)}
          onLoad={() => void acknowledgeOnce(current)}
        />
      )}
      {candidate && (
        <Image
          source={{ uri: candidate.uri }}
          resizeMode={candidate.fit}
          style={[styles.fullscreen, styles.candidate]}
          onLoad={() => void acceptCandidate()}
          onError={({ nativeEvent }) => rejectCandidate(candidate, String(nativeEvent.error ?? "decode failed"))}
        />
      )}
      {playerError && !(isImageVisible && status === "offline") && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{playerError}</Text>
        </View>
      )}
      {isImageVisible && status === "offline" && (
        <Pressable
          hasTVPreferredFocus={!offlinePopup}
          focusable={!offlinePopup}
          onPress={() => setOfflinePopup(true)}
          style={({ focused }) => [styles.offlineDot, focused && styles.offlineDotFocused]}
        />
      )}
      {offlinePopup && isImageVisible && status === "offline" && (
        <View style={styles.popupBackdrop}>
          <View style={styles.popup}>
            <Text style={styles.popupTitle}>Server offline</Text>
            <Text style={styles.popupMessage}>Showing the last saved content until the server is back.</Text>
            <View style={styles.popupActions}>
              <Pressable onPress={() => setOfflinePopup(false)} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
                <Text style={styles.buttonText}>Close</Text>
              </Pressable>
              <Pressable hasTVPreferredFocus onPress={retryConnection} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
                <Text style={styles.buttonText}>Reconnect</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
      {!isImageVisible && (
        <View style={styles.panel}>
          <Text style={styles.brand}>SPINCO <Text style={styles.brandAccent}>CONNECT</Text></Text>
          <Image
            source={require("./assets/spinco-logo.png")}
            resizeMode="contain"
            accessibilityLabel="Spinco logo"
            style={[styles.logo, pairing && styles.logoCompact]}
          />
          <View style={styles.statusRow}>
            {status !== "offline" && !revoked && <ActivityIndicator color="#70e0ae" />}
            <Text style={styles.message}>{message}</Text>
          </View>
          {pairing && (
            <>
              <Text style={styles.instruction}>
                {revoked ? "To reconnect, enter this code in the admin dashboard" : "Enter this temporary code in the admin dashboard"}
              </Text>
              <Text selectable style={styles.code}>{pairing.code}</Text>
              <Text style={styles.expiry}>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</Text>
              <Pressable hasTVPreferredFocus onPress={retryConnection} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
                <Text style={styles.buttonText}>{revoked ? "Reconnect" : "Check pairing status"}</Text>
              </Pressable>
            </>
          )}
          {status === "offline" && (
            <Pressable
              hasTVPreferredFocus
              onPress={retryConnection}
              style={({ focused }) => [styles.button, focused && styles.buttonFocused]}
            >
              <Text style={styles.buttonText}>Retry connection</Text>
            </Pressable>
          )}
          <Text style={styles.server}>Server: {API_URL}</Text>
        </View>
      )}
      {showSplash && (
        <View style={styles.splash}>
          <Text style={styles.splashBrand}>SPINCO <Text style={styles.splashAccent}>CONNECT</Text></Text>
          <Image
            source={require("./assets/spinco-logo.png")}
            resizeMode="contain"
            accessibilityLabel="Spinco logo"
            style={styles.splashLogo}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#080d13", alignItems: "center", justifyContent: "center" },
  fullscreen: { ...StyleSheet.absoluteFill, width: undefined, height: undefined },
  // Kept above 0 so Android cannot skip loading a fully transparent view.
  candidate: { opacity: 0.01 },
  splash: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff" },
  splashBrand: { color: "#1a1c19", fontSize: 44, fontWeight: "800", letterSpacing: 4, marginBottom: 24 },
  splashAccent: { color: "#e8833a" },
  splashLogo: { width: 220, height: 220 },
  panel: { flex: 1, alignItems: "center", justifyContent: "center", width: "100%", paddingHorizontal: 48, paddingVertical: 24 },
  // White backing keeps the logo's black outline and tagline readable on the dark screen.
  logo: { width: 180, height: 180, marginBottom: 20, borderRadius: 16, backgroundColor: "#ffffff" },
  // The pairing view fills a 540dp-tall TV screen, so the logo shrinks to keep the code and button visible.
  logoCompact: { width: 96, height: 96, marginBottom: 12, borderRadius: 10 },
  brand: { color: "#f6f8fa", fontSize: 28, fontWeight: "800", letterSpacing: 4, marginBottom: 24 },
  brandAccent: { color: "#70e0ae" },
  statusRow: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 12 },
  message: { color: "#bac5cf", fontSize: 21, textAlign: "center" },
  instruction: { color: "#bac5cf", fontSize: 22, marginTop: 40 },
  code: { color: "#70e0ae", fontSize: 60, fontWeight: "800", letterSpacing: 16, marginTop: 16 },
  expiry: { color: "#7d8b98", fontSize: 16, marginTop: 10 },
  server: { position: "absolute", bottom: 8, color: "#56616d", fontSize: 13 },
  offlineDot: { position: "absolute", top: 24, right: 24, width: 22, height: 22, borderRadius: 11, backgroundColor: "#eb4d55" },
  offlineDotFocused: { borderWidth: 3, borderColor: "#f6f8fa", transform: [{ scale: 1.4 }] },
  popupBackdrop: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: "#000000aa" },
  popup: { width: 560, padding: 32, borderRadius: 16, backgroundColor: "#111a20" },
  popupTitle: { color: "#f6f8fa", fontSize: 28, fontWeight: "800" },
  popupMessage: { color: "#bac5cf", fontSize: 20, marginTop: 12 },
  popupActions: { flexDirection: "row", justifyContent: "flex-end", gap: 16 },
  errorBar: { position: "absolute", bottom: 28, left: 28, right: 28, padding: 14, borderRadius: 10, backgroundColor: "#261719ee" },
  errorText: { color: "#ffb6b9", fontSize: 16, textAlign: "center" },
  button: { marginTop: 32, paddingHorizontal: 28, paddingVertical: 16, borderRadius: 12, backgroundColor: "#14232b" },
  buttonFocused: { backgroundColor: "#70e0ae", transform: [{ scale: 1.05 }] },
  buttonText: { color: "#f6f8fa", fontSize: 20, fontWeight: "700" },
});
