const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withTvLauncher(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      application.$["android:usesCleartextTraffic"] = process.env.APP_ENV === "production" ? "false" : "true";
    }
    return mod;
  });
};
