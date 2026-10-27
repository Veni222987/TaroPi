---
name: genshine-sign
description: 在已连接的安卓设备上完成米游社原神每日签到。仅当用户明确说到原神签到时使用，其他情况不要加载。
---

# 原神签到

在一台已经可以控制的安卓设备上，打开米游社并完成原神每日签到。不要写设备怎么连接，默认已有一台可用设备。

进入签到 H5 之前，只用截图和原生 `input` 指令。`local.h5tap` 只用于签到页：那是米游社里的内嵌网页，`adb shell input tap` 点不进去。

全部做完（签到成功，或确认今天已经签过）后，先把结果截图留下，再强制关闭米游社并息屏。不要把应用和屏幕留着。

## 前置校验

1. 确认有一台已连接的安卓设备，虚拟机或真机的 ADB 都行：`adb devices` 里状态为 `device`。多台时用 `-s <serial>` 指定，下面命令里的 `$S` 就是这个序列号。
2. 设备上已安装米游社，包名 `com.mihoyo.hyperion`，并且已登录、绑定了原神角色。
3. 进入签到 H5 之前不要装点击服务。只有当前焦点已经是 `com.mihoyo.hyperion.web2.MiHoYoWebActivity`，并且标题是「米游社原神每日签到」时，才检查并使用本 skill 自带的点击服务。没装过就跑一次本 skill 目录的 `h5tap/build.sh`：

```bash
bash <skill目录>/h5tap/build.sh "$S"
```

脚本会编译 `h5tap/src`、安装 `local.h5tap` 并打开无障碍服务。如果之后点击没有反应，让用户在设备上打开：设置 → 辅助功能 → 已安装的服务 → H5 Tap，并点允许。

确认服务在跑：

```bash
adb -s "$S" shell settings get secure enabled_accessibility_services
```

输出应包含 `local.h5tap/local.h5tap.TapService`。

## 原生界面怎么操作

唤醒、解锁、打开米游社、切换游戏分页、回到顶部、点「签到福利」，都用截图配合原生指令，不要用 `h5tap`。

截图：

```bash
adb -s "$S" exec-out screencap -p > /tmp/screen.png
```

看图确定坐标后再点。文字节点往往比可点区域窄，不要只凭文字矩形的中心下手。

```bash
adb -s "$S" shell input tap X Y
adb -s "$S" shell input swipe X1 Y1 X2 Y2 300
```

信息流把顶部入口滚出去时，从上往下快速滑，把页面拉回顶部，再截图。例如 1200x2000：

```bash
adb -s "$S" shell input swipe 600 500 600 1700 200
```

## 点击服务怎么用

只在签到 H5 里使用。用广播下指令，不要写 `h5tap.cmd`。结果写在 `/sdcard/Android/data/local.h5tap/files/h5tap.txt`。

读出当前界面里的文字和坐标（内嵌网页也能读到）：

```bash
D=/sdcard/Android/data/local.h5tap/files
adb -s "$S" shell am broadcast -a local.h5tap.CMD -p local.h5tap --es op dump
sleep 1
adb -s "$S" shell cat $D/h5tap.txt
```

每行格式是 `left,top,right,bottom|类名|文字|描述`。点击取矩形中心，并用截图核对是不是点在图标上：

```bash
adb -s "$S" shell am broadcast -a local.h5tap.CMD -p local.h5tap --es op tap --es x X --es y Y
```

点完先等待再截图：`adb -s "$S" exec-out screencap -p > /tmp/screen.png`。

## 签到流程

1. 如果屏幕没亮，或者还停在锁屏，先唤醒再上滑解锁。已经解锁就跳过。

```bash
adb -s "$S" shell dumpsys power | grep -E 'mWakefulness=|Display Power: state='
adb -s "$S" shell dumpsys window | grep -E 'mDreamingLockscreen=|mShowingLockscreen=|mCurrentFocus='
```

`mWakefulness` 不是 `Awake`、屏幕不是亮的、锁屏标记为 `true`，或当前焦点还在 `Keyguard` / `NotificationShade`，就执行：

```bash
adb -s "$S" shell input keyevent KEYCODE_WAKEUP
adb -s "$S" shell wm size
```

`wm size` 里的 Physical size 是 `宽x高`。从屏幕底部往上滑：横坐标取宽的一半，起点纵坐标约为高的 90%，终点约为高的 30%，时长 300ms。例如 1200x2000：

```bash
adb -s "$S" shell input swipe 600 1800 600 600 300
```

滑完再查一次。锁屏标记仍是 `true`，或焦点还在密码、图案界面，停下来让用户自己解开，不要猜密码，也不要继续签到。

2. 打开米游社：

```bash
adb -s "$S" shell am start -n com.mihoyo.hyperion/com.mihoyo.hyperion.main.HyperionMainActivity
```

3. 点原神。首页顶部有游戏分页，截图找文字为「原神」的项，用 `input tap` 点它。如果当前已经在原神分页（顶部能看到「签到福利」），跳过这一步。
4. 点每日签到。截图找「签到福利」图标，用 `input tap` 点图标中心，不要只点文字。看不到顶部入口时先下拉回顶。会进入标题为「米游社原神每日签到」的页面，焦点是 `MiHoYoWebActivity`。这是内嵌网页，加载需要几秒，等到截图或 `dump` 能看到「已累计签到」再继续。从这一步开始才用 `h5tap`。
5. 判断今天要不要签。先截图，再 `dump` 读「10月已累计签到 N 天」。有漏签时页面不会写「今日已签」，不要拿累计天数当成今天没签。看第 N+1 天的卡片：
   - 有橙色高亮背景，并且右上角有红点：今天待签。用 `h5tap` 的 `tap` 点这张卡片的中心。
   - 没有橙色高亮和红点，和后面的天数一样是灰底：今天已经签过，第 N+1 天是明天的奖励。保留截图，不要再点，也不要自己点「补签」。补签会花米游币，并且只补当月最早漏掉的那一天，只有用户明确要求时才做。
6. 点过待签卡片后再截图、再 `dump`。确认弹出「签到成功」，并且累计天数比点击前多 1。累计天数没有变化时，重新截图和 `dump` 拿坐标再点一次，不要用旧坐标。
7. 收尾。无论是刚签完还是确认今天已签，汇报前先关闭米游社再息屏。期间改过屏幕超时，先改回原来的值：

```bash
adb -s "$S" shell am force-stop com.mihoyo.hyperion
adb -s "$S" shell input keyevent KEYCODE_SLEEP
```

签到页加载慢，每次点击后先等待再截图或 `dump`，不要连续点。
