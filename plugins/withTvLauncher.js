const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withTvLauncher(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      application.$["android:usesCleartextTraffic"] = process.env.APP_ENV === "production" ? "false" : "true";
    }
    const activity = application?.activity?.find((item) =>
      item.$?.["android:name"]?.endsWith("MainActivity"),
    );

    if (activity) {
      const filters = activity["intent-filter"] ?? [];
      const mainFilter = filters.find((filter) =>
        filter.action?.some((action) => action.$?.["android:name"] === "android.intent.action.MAIN"),
      );
      if (mainFilter) {
        mainFilter.category ??= [];
        for (const name of ["android.intent.category.HOME", "android.intent.category.DEFAULT"]) {
          if (!mainFilter.category.some((category) => category.$?.["android:name"] === name)) {
            mainFilter.category.push({ $: { "android:name": name } });
          }
        }
      }
    }

    return mod;
  });
};
