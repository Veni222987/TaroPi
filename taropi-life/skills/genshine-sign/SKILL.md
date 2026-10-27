---
name: genshine-sign
description: 在已连接的安卓设备上完成米游社原神每日签到。仅当用户明确说到原神签到时使用，其他情况不要加载。
---

# 原神签到

在一台已经可以控制的安卓设备上，打开米游社并完成原神每日签到。不要写设备怎么连接，默认已有一台可用设备。

## 前置校验

1. 确认有一台已连接的安卓设备，虚拟机或真机的 ADB 都行：`adb devices` 里状态为 `device`。多台时用 `-s <serial>` 指定，下面命令里的 `$S` 就是这个序列号。
2. 设备上已安装米游社，包名 `com.mihoyo.hyperion`，并且已登录、绑定了原神角色。
3. 签到页是米游社里的内嵌网页，`adb shell input tap` 点不进去。必须先安装本 skill 自带的点击服务，脚本在本 skill 目录的 `h5tap/build.sh`：

```bash
bash <skill目录>/h5tap/build.sh "$S"
```

脚本会编译 `h5tap/src`、安装 `local.h5tap` 并打开无障碍服务。如果之后点击没有反应，让用户在设备上打开：设置 → 辅助功能 → 已安装的服务 → H5 Tap，并点允许。

确认服务在跑：

```bash
adb -s "$S" shell settings get secure enabled_accessibility_services
```

输出应包含 `local.h5tap/local.h5tap.TapService`。

## 点击服务怎么用

服务每半秒读一次指令文件，执行后把结果写到同目录的 `h5tap.out`。目录是 `/sdcard/Android/data/local.h5tap/files`。

读出当前界面里的文字和坐标（内嵌网页也能读到）：

```bash
D=/sdcard/Android/data/local.h5tap/files
adb -s "$S" shell "rm -f $D/h5tap.out; echo dump > $D/h5tap.cmd"
sleep 1
adb -s "$S" shell cat $D/h5tap.out
```

每行格式是 `left,top,right,bottom|类名|文字|描述`。点击取矩形中心：

```bash
adb -s "$S" shell "rm -f $D/h5tap.out; echo 'tap X Y' > $D/h5tap.cmd"
sleep 1
adb -s "$S" shell cat $D/h5tap.out   # TAP_OK 表示已发出手势
```

点完截图确认：`adb -s "$S" exec-out screencap -p > /tmp/screen.png`。

## 签到流程

1. 如果屏幕没亮，或者还停在锁屏，先唤醒再上滑解锁。已经解锁就跳过。

```bash
adb -s "$S" shell dumpsys power | grep -E 'mWakefulness=|Display Power: state='
adb -s "$S" shell dumpsys window | grep -E 'mDreamingLockscreen=|mShowingLockscreen=|mCurrentFocus='
```

`mWakefulness` 不是 `Awake`、`Display Power: state` 不是 `ON`、锁屏标记为 `true`，或当前焦点还在 `Keyguard` / `NotificationShade`，就执行：

```bash
adb -s "$S" shell input keyevent KEYCODE_WAKEUP
adb -s "$S" shell wm size
```

`wm size` 里的 Physical size 是 `宽x高`。从屏幕底部往上滑：横坐标取宽的一半，起点纵坐标约为高的 90%，终点约为高的 30%，时长 300ms。例如 1080x2400：

```bash
adb -s "$S" shell input swipe 540 2160 540 720 300
```

滑完再查一次。锁屏标记仍是 `true`，或焦点还在密码、图案界面，停下来让用户自己解开，不要猜密码，也不要继续签到。

2. 打开米游社：

```bash
adb -s "$S" shell am start -n com.mihoyo.hyperion/com.mihoyo.hyperion.main.HyperionMainActivity
```

3. 点原神。首页顶部有游戏分页，用 `dump` 找文字为「原神」的项，点它的中心。如果当前已经在原神分页（顶部能看到「签到福利」），跳过这一步。
4. 点每日签到。用 `dump` 找「签到福利」，点它的中心，会进入标题为「米游社原神每日签到」的页面。这是内嵌网页，加载需要几秒，等到 `dump` 能读到「第1天」再继续。
5. 完成签到。在 `dump` 结果里找第一个还没有签过的天数卡片并点它的中心。页面上「已累计签到 N 天」的下一天就是今天。
6. 再 `dump` 一次确认：累计天数比点击前多 1，并且该天已经打勾。截图给用户看。如果累计天数没有变化，重新 `dump` 拿坐标再点一次，不要用旧坐标。

签到页加载慢，每次点击后先等待再截图或 `dump`，不要连续点。
