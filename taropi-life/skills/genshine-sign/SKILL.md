---
name: genshine-sign
description: 在局域网安卓设备上完成米游社原神每日签到。先发现并重连设备，不要假设已经连上。仅当用户明确说到原神签到时使用，其他情况不要加载。
---

# 原神签到

打开米游社并完成原神每日签到。电脑重启后旧的无线调试连接会掉，不要默认已有可用设备。先按「发现并重连」拿到一台状态为 `device` 的设备，再签到。

进入签到 H5 之前，只用截图和原生 `input` 指令。`local.h5tap` 只用于签到页：那是米游社里的内嵌网页，`adb shell input tap` 点不进去。

全部做完（签到成功，或确认今天已经签过）后，先把结果截图留下，再强制关闭米游社并息屏。不要把应用和屏幕留着。

## 发现并重连

设备是局域网里的三星平板 `SM-P610`（`gta4xlwifi`），走无线调试，不是 USB。电脑重启后连接会掉，不要当成已经连上。用户不会去改平板上的调试开关，下面这组参数是固定默认值，直接用，不要现问，也不要扫端口：

- IP：`192.168.2.24`
- 连接端口：`33295`，序列号 `$S` 就是 `192.168.2.24:33295`
- 配对端口：`38217`，配对码：`748050`
- 配对过的设备名：`adb-R52RA09S7ND-l4Op1e`

配对码只在这一台、这一次配对里有效。本机已经配对成功过，密钥在 `~/.android`，平时只要 `adb connect`，不要每次都 `adb pair`。

1. 先看现在连着谁：

```bash
adb devices -l
adb mdns services
```

`192.168.2.24:33295` 已经是 `device`，就用它，不要再连一次。`unauthorized` 停下来告诉用户，不要重配。`mdns services` 里有别的 `_adb-tls-connect._tcp` 地址时，只用它给出的这一台地址，不要猜别的设备。

2. 没有 `device` 就按默认地址重连：

```bash
adb connect 192.168.2.24:33295
adb devices -l
```

连上且状态为 `device` 就继续。不要试 `5555`，也不要扫描其他端口。

3. `adb connect` 失败时，先分清是平板不在线，还是这台电脑暂时没解析到它。用户处的路由器能看到 `192.168.2.24` 在线，不能拿一次 ping 失败就说平板关机或换了地址。先看本机是不是还在同一网段，再看 ARP：

```bash
ifconfig en1 | grep 'inet '
ping -c 3 -W 1000 192.168.2.24
arp -n 192.168.2.24
```

本机地址应在 `192.168.2.0/24`（曾是 `192.168.2.19`）。ARP 显示 `(incomplete)` 或 ping 出现 `No route to host`，是链路层还没拿到 MAC `5e:2d:53:f2:e8:7a`，不是端口变了。隔几秒再 ping 两到三次。能通之后用 `nc` 确认 `33295` 仍开着：

```bash
nc -z -G 2 192.168.2.24 33295
```

`nc` 成功但 `adb connect` 仍是 `No route to host`，就是 ADB 服务缓存了刚才的失败。重启服务再连，不要 `adb pair`，也不要扫端口：

```bash
adb kill-server
adb start-server
adb connect 192.168.2.24:33295
adb devices -l
```

本机不在 `192.168.2.0/24`，或 ARP 一直不完整且 ping 始终 100% 丢包，再停下来告诉用户。不要猜新的 IP。

4. 只有 ping 已经稳定成功、`33295` 也确认开着，重启 ADB 后 `adb connect` 仍然失败，才用同一组参数重配一次：

```bash
adb pair 192.168.2.24:38217 748050
adb connect 192.168.2.24:33295
adb devices -l
```

`adb pair` 成功但 `connect` 仍失败，才说明连接端口变了。停下来告诉用户，不要自己扫端口。`adb pair` 拒绝这个配对码，也停下来告诉用户。不要猜新的端口或配对码。

5. 拿到 `device` 之后确认是这台平板，并且已安装米游社 `com.mihoyo.hyperion`。型号不是 `SM-P610` 就停下来告诉用户，不要在别的设备上继续。

```bash
adb -s "$S" shell getprop ro.product.model
adb -s "$S" shell pm path com.mihoyo.hyperion
```

## 前置校验

1. 上面的重连已经拿到一台状态为 `device` 的设备，`$S` 是它的序列号。这一步不要再假设设备还连着。
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
4. 关掉挡在首页上的弹窗。截图看到「未成年人模式」时，点蓝色的「不再提醒」，不要点「进入未成年人模式」。按钮位置以截图或 `uiautomator dump` 为准，不要沿用旧坐标；1200x2000 上它曾在 `(600, 1219)`。点完再截图，弹窗还在就按新坐标重试一次。其他遮住「签到福利」的活动弹窗，点右上角关闭或「不再提醒」一类按钮，不要进入弹窗推广的页面。
5. 点每日签到。截图找「签到福利」图标，用 `input tap` 点图标中心，不要只点文字。看不到顶部入口时先下拉回顶。会进入标题为「米游社原神每日签到」的页面，焦点是 `MiHoYoWebActivity`。这是内嵌网页，加载需要几秒，等到截图或 `dump` 能看到「已累计签到」再继续。从这一步开始才用 `h5tap`。
6. 确认点击服务可用。`settings get secure enabled_accessibility_services` 不含 `local.h5tap/local.h5tap.TapService` 时，服务可能只是被关掉，先查 `adb -s "$S" shell pm path local.h5tap`。已安装就重新打开，不要重新编译：

```bash
adb -s "$S" shell settings put secure enabled_accessibility_services local.h5tap/local.h5tap.TapService
adb -s "$S" shell settings put secure accessibility_enabled 1
```

没安装才运行 `h5tap/build.sh`。第一次 `dump` 写出的 `h5tap.txt` 可能是空的，隔 1 到 2 秒再 `dump` 一次。仍是空文件或内容是 `SERVICE_NOT_RUNNING`，让用户到设置 → 辅助功能 → 已安装的服务里允许 H5 Tap。
7. 判断今天要不要签。先截图，再 `dump` 读「10月已累计签到 N 天」。有漏签时页面不会写「今日已签」，不要拿累计天数当成今天没签。看第 N+1 天的卡片：
   - 有橙色高亮背景，并且右上角有红点：今天待签。用 `h5tap` 的 `tap` 点这张卡片里奖励图标的中心，不要只点底部的「第N天」文字。
   - 没有橙色高亮和红点，和后面的天数一样是灰底：今天已经签过，第 N+1 天是明天的奖励。保留截图，不要再点，也不要自己点「补签」。补签会花米游币，并且只补当月最早漏掉的那一天，只有用户明确要求时才做。
8. 点过待签卡片后先等 2 到 3 秒，再截图、再 `dump`。确认弹出「签到成功」，并且累计天数比点击前多 1。累计天数没有变化时，重新截图和 `dump` 拿坐标再点一次，不要用旧坐标。操作中途屏幕变黑，就是自动息屏，不是点击成功；先唤醒解锁，确认签到页还在，再按页面状态继续。需要连续操作时，可临时把 `screen_off_timeout` 调到 `600000`，收尾前必须改回原来的值。先读出现在的值，结束时写回这个值，不要写死一个数。
9. 「签到成功」弹窗底下的关闭按钮是网页里的圆形叉，`dump` 里通常没有「关闭」文字。不要用肉眼估计的坐标去点，点偏会点进弹窗里的推荐图。先在截图上量出叉的中心再 `tap`。弹窗关掉后，第 N+1 天应变成绿勾，累计天数比点击前多 1，再进入收尾。
10. 收尾。无论是刚签完还是确认今天已签，汇报前先关闭米游社再息屏。期间改过屏幕超时，先改回原来的值：

```bash
adb -s "$S" shell am force-stop com.mihoyo.hyperion
adb -s "$S" shell input keyevent KEYCODE_SLEEP
```

签到页加载慢，每次点击后先等待再截图或 `dump`，不要连续点。
