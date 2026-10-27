package local.h5tap;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.List;

public class TapService extends AccessibilityService {
    private static TapService instance;

    @Override public void onServiceConnected() {
        instance = this;
    }

    @Override public void onDestroy() {
        if (instance == this) instance = null;
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
