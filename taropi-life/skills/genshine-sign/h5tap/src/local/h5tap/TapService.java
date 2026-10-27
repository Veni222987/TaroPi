package local.h5tap;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.List;

public class TapService extends AccessibilityService {
    private static TapService instance;

    private volatile boolean running;

    @Override public void onServiceConnected() {
        instance = this;
        running = true;
        new Thread(new Poller(this)).start();
    }

    @Override public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
    }

    public boolean isRunning() { return running; }

    public void poll() {
        java.io.File cmd = new java.io.File(getExternalFilesDir(null), "h5tap.cmd");
        if (!cmd.exists()) return;
        String line;
        try {
            java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader(cmd));
            line = reader.readLine();
            reader.close();
            cmd.delete();
        } catch (Exception e) {
            return;
        }
        if (line == null) return;
        String result;
        if (line.startsWith("tap ")) {
            String[] parts = line.split(" ");
            result = tap(Integer.parseInt(parts[1]), Integer.parseInt(parts[2])) ? "TAP_OK" : "TAP_FAIL";
        } else if (line.startsWith("click ")) {
            result = "CLICKED " + clickText(line.substring(6));
        } else if (line.equals("dump")) {
            result = dump();
        } else {
            result = "UNKNOWN";
        }
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getExternalFilesDir(null), "h5tap.out"));
            out.write(result.getBytes("UTF-8"));
            out.close();
        } catch (Exception ignored) {}
    }

    @Override public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent e) {}

    @Override public void onInterrupt() {}

    public static TapService get() { return instance; }

    public boolean tap(int x, int y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 80))
            .build();
        return dispatchGesture(gesture, null, null);
    }

    public String dump() {
        StringBuilder sb = new StringBuilder();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "NO_ROOT";
        walk(root, sb);
        root.recycle();
        return sb.toString();
    }

    public int clickText(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return -1;
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
        int clicked = 0;
        for (AccessibilityNodeInfo node : nodes) {
            if (node.isClickable()) {
                node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                clicked++;
            } else {
                AccessibilityNodeInfo parent = node.getParent();
                if (parent != null && parent.isClickable()) {
                    parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    clicked++;
                    parent.recycle();
                }
            }
            node.recycle();
        }
        root.recycle();
        return clicked;
    }

    private void walk(AccessibilityNodeInfo node, StringBuilder sb) {
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        if ((text != null && text.length() > 0) || (desc != null && desc.length() > 0)) {
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            sb.append(r.left).append(',').append(r.top).append(',').append(r.right).append(',').append(r.bottom)
              .append('|').append(node.getClassName())
              .append('|').append(text == null ? "" : text)
              .append('|').append(desc == null ? "" : desc)
              .append('\n');
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                walk(child, sb);
                child.recycle();
            }
        }
    }
}
