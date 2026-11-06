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
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#ffffff" },
    softwareKeyboardLayoutMode: "pan",
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    ["@react-native-tvos/config-tv", { isTV: true, androidTVRequired: true, androidTVBanner: "./assets/tv-banner.png" }],
    "./plugins/withTvLauncher",
    "expo-dev-client",
    "expo-secure-store",
    ["expo-splash-screen", { image: "./assets/splash-logo.png", imageWidth: 288, backgroundColor: "#ffffff" }],
  ],
};

export default config;
