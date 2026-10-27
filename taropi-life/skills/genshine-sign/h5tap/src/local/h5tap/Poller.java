package local.h5tap;

public class Poller implements Runnable {
    private final TapService service;

    public Poller(TapService service) { this.service = service; }

    public void run() {
        while (service.isRunning()) {
            try {
                service.poll();
                Thread.sleep(500);
            } catch (Exception ignored) {}
        }
    }
}
