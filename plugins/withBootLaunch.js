const fs = require("fs");
const path = require("path");
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const RECEIVER_NAME = ".BootReceiver";
const BOOT_ACTIONS = ["android.intent.action.BOOT_COMPLETED", "android.intent.action.QUICKBOOT_POWERON"];

const receiverSource = (packageName) => `package ${packageName}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action !in BOOT_ACTIONS) return
    val packageManager = context.packageManager
    val launchIntent = packageManager.getLeanbackLaunchIntentForPackage(context.packageName)
      ?: packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return
    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(launchIntent)
  }

  private companion object {
    val BOOT_ACTIONS = setOf(${BOOT_ACTIONS.map((action) => `"${action}"`).join(", ")})
  }
}
`;

// Opens the app after the device boots without registering it as the Home app, so Back still reaches the TV home screen.
module.exports = function withBootLaunch(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    const receivers = (application.receiver ?? []).filter((item) => item.$["android:name"] !== RECEIVER_NAME);
    receivers.push({
      $: { "android:name": RECEIVER_NAME, "android:enabled": "true", "android:exported": "true" },
      // Boot broadcasts reach receivers one at a time, so a high priority avoids queueing behind other apps.
      "intent-filter": [{ $: { "android:priority": "1000" }, action: BOOT_ACTIONS.map((name) => ({ $: { "android:name": name } })) }],
    });
    application.receiver = receivers;
    return mod;
  });

  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const packageName = mod.android?.package;
      if (!packageName) throw new Error("withBootLaunch requires android.package");
      const directory = path.join(mod.modRequest.platformProjectRoot, "app/src/main/java", ...packageName.split("."));
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(path.join(directory, "BootReceiver.kt"), receiverSource(packageName));
      return mod;
    },
  ]);
};
