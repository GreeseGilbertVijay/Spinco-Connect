import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Spinco Connect",
  slug: "spinco-connect",
  version: "1.0.0",
  orientation: "landscape",
  icon: "./assets/icon.png",
  extra: {
    eas: { projectId: "42fda22b-f307-4584-a562-458ffc4bfb95" },
  },
  android: {
    package: "com.spinco.connect",
    // The last three are for receiving a live screen share. The player only receives,
    // so the camera and microphone permissions WebRTC can use are left out.
    permissions: [
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.WAKE_LOCK",
    ],
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#ffffff" },
    softwareKeyboardLayoutMode: "pan",
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    ["@react-native-tvos/config-tv", { isTV: true, androidTVRequired: true, androidTVBanner: "./assets/tv-banner.png" }],
    "./plugins/withTvLauncher",
    "./plugins/withBootLaunch",
    "./plugins/withWebRtcProguard",
    "expo-dev-client",
    "expo-secure-store",
    ["expo-navigation-bar", { hidden: true }],
    ["expo-splash-screen", { image: "./assets/splash-logo.png", imageWidth: 288, backgroundColor: "#ffffff" }],
  ],
};

export default config;
