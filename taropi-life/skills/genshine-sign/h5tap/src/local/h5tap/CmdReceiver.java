package local.h5tap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.io.FileOutputStream;

public class CmdReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getStringExtra("op");
        TapService service = TapService.get();
        String result;
        if (service == null) {
            result = "SERVICE_NOT_RUNNING";
        } else if ("tap".equals(action)) {
            int x = Integer.parseInt(intent.getStringExtra("x"));
            int y = Integer.parseInt(intent.getStringExtra("y"));
            result = service.tap(x, y) ? "TAP_OK" : "TAP_FAIL";
        } else if ("click".equals(action)) {
            result = "CLICKED " + service.clickText(intent.getStringExtra("text"));
        } else if ("dump".equals(action)) {
            result = service.dump();
        } else {
            result = "UNKNOWN";
        }
        try {
            File dir = context.getExternalFilesDir(null);
            FileOutputStream out = new FileOutputStream(new java.io.File(dir, "h5tap.txt"));
            out.write(result.getBytes("UTF-8"));
            out.close();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
