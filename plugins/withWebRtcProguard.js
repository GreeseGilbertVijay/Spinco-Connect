const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

// react-native-webrtc 155 refers to an optional AV1 decoder (org.webrtc.Dav1dDecoder) that its
// Android library does not ship, so R8 stops the minified release build on the missing class.
// The library's own rules already keep every org.webrtc class that does exist.
const RULES = `
# Added by plugins/withWebRtcProguard.js
-dontwarn org.webrtc.**
`;

module.exports = function withWebRtcProguard(config) {
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const file = path.join(mod.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
      const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!contents.includes("withWebRtcProguard")) fs.writeFileSync(file, `${contents.trimEnd()}\n${RULES}`);
      return mod;
    },
  ]);
};
