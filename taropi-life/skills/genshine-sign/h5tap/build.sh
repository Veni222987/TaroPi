#!/bin/bash
# Build and install the H5 tap accessibility service on the connected device.
# Requires: adb, a JDK, and an Android SDK with platform android-34 and build-tools 34.0.0.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src"
OUT="$HERE/build"
SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
KEY="$HERE/debug.keystore"
SERIAL="${1:-}"
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$PATH"

rm -rf "$OUT"
mkdir -p "$OUT/classes"
"$BT/aapt" package -f -M "$SRC/AndroidManifest.xml" -S "$SRC/local/h5tap/res" \
  -I "$SDK/platforms/android-34/android.jar" -J "$SRC" -F "$OUT/base.apk"
javac --release 8 -Xlint:-options -classpath "$SDK/platforms/android-34/android.jar" \
  -d "$OUT/classes" "$SRC/local/h5tap/"*.java "$SRC/R.java"
( cd "$OUT/classes" && jar cf "$OUT/classes.jar" . )
"$BT/d8" --min-api 26 --lib "$SDK/platforms/android-34/android.jar" --output "$OUT" "$OUT/classes.jar"
( cd "$OUT" && "$BT/aapt" add base.apk classes.dex >/dev/null )
[ -f "$KEY" ] || keytool -genkeypair -keystore "$KEY" -storepass android -keypass android \
  -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Debug'
java -jar "$BT/lib/apksigner.jar" sign --ks "$KEY" --ks-pass pass:android \
  --key-pass pass:android --out "$OUT/h5tap.apk" "$OUT/base.apk"

"${ADB[@]}" install "$OUT/h5tap.apk"
"${ADB[@]}" shell settings put secure enabled_accessibility_services local.h5tap/local.h5tap.TapService
"${ADB[@]}" shell settings put secure accessibility_enabled 1
echo "installed. If taps do nothing, enable H5 Tap under Settings > Accessibility > Installed services."
