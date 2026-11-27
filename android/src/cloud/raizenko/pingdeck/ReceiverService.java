package cloud.raizenko.pingdeck;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ReceiverService extends Service {
    private static final String SERVICE_CHANNEL = "connection";
    private static final String NORMAL_CHANNEL = "alerts";
    private static final String URGENT_CHANNEL = "urgent";
    private static final String QUIET_CHANNEL = "quiet";
    private static final int ONGOING = 100;
    private static final String PAUSE = "cloud.raizenko.pingdeck.PAUSE";
    private static volatile boolean receiving;
    private volatile boolean running;

    static boolean isReceiving() { return receiving; }
    private Thread receiver;
    private State state;
    private NotificationManager manager;

    static boolean hasPermission(Context context) {
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        return notifications.areNotificationsEnabled() && (Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }

    @Override public void onCreate() {
        super.onCreate();
        state = new State(this);
        manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(SERVICE_CHANNEL, "Pripojenie k serveru", NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(NORMAL_CHANNEL, "Upozornenia", NotificationManager.IMPORTANCE_DEFAULT));
        manager.createNotificationChannel(new NotificationChannel(URGENT_CHANNEL, "Dôležité upozornenia", NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(new NotificationChannel(QUIET_CHANNEL, "Tiché upozornenia", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && PAUSE.equals(intent.getAction())) {
            state.setActive(false);
            state.setStatus("Príjem je pozastavený.");
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification foreground = foreground();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ONGOING, foreground, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ONGOING, foreground);
        }
        if (!state.paired() || !state.active() || !hasPermission(this)) {
            state.setActive(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (receiver == null) {
            receiving = true;
            running = true;
            receiver = new Thread(this::listen, "PingDeck receiver");
            receiver.start();
        }
        return START_STICKY;
    }

    private Notification foreground() {
        Intent pause = new Intent(this, ReceiverService.class).setAction(PAUSE);
        PendingIntent action = PendingIntent.getService(this, 0, pause, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, SERVICE_CHANNEL)
                .setSmallIcon(R.drawable.ic_alert)
                .setContentTitle("PingDeck")
                .setContentText("Príjem upozornení je zapnutý.")
                .setContentIntent(openApp())
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Pozastaviť", action).build())
                .build();
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    private void listen() {
        String token;
        Api api;
        try {
            token = state.token();
            api = new Api(state.base());
            if (token == null) {
                stopSelf();
                return;
            }
        } catch (Exception error) {
            state.setActive(false);
            state.setStatus("Párovací kľúč je nedostupný. Odpoj telefón a spáruj ho znova.");
            stopSelf();
            return;
        }

        int delay = 2_000;
        state.setStatus("Pripájam sa k serveru…");
        while (running && state.active() && state.paired()) {
            if (!hasPermission(this)) {
                state.setActive(false);
                state.setStatus("Upozornenia sú vypnuté v nastaveniach telefónu.");
                break;
            }
            try {
                JSONArray messages = api.call("GET", "messages", token, null).getJSONArray("messages");
                if (!running || !state.active() || !token.equals(state.token())) break;
                state.setStatus("Príjem je zapnutý. Server je dostupný.");
                JSONArray ids = new JSONArray();
                for (int index = 0; index < messages.length(); index++) {
                    if (!running || !state.active() || !hasPermission(this)) break;
                    JSONObject message = messages.getJSONObject(index);
                    String id = message.getString("id");
                    if (!state.hasMessage(id)) {
                        show(message, id);
                        state.saveMessage(message);
                    }
                    ids.put(id);
                }
                if (ids.length() > 0 && running && state.active()) {
                    api.call("POST", "ack", token, new JSONObject().put("ids", ids));
                }
                delay = 2_000;
                continue;
            } catch (Api.Failure error) {
                if (!running || !state.active()) break;
                if (error.status == 401) {
                    state.unpair();
                    state.setStatus("Odber bol zrušený. Zadaj nový párovací kód.");
                    break;
                }
            } catch (Exception error) {
                if (!running || !state.active()) break;
            }
            state.setStatus("Server je nedostupný. Skúšam obnoviť pripojenie.");
            try { Thread.sleep(delay); }
            catch (InterruptedException error) { break; }
            delay = Math.min(delay * 2, 30_000);
        }
        stopSelf();
    }

    private void show(JSONObject item, String id) throws Exception {
        String urgency = item.optString("urgency");
        String channel = "high".equals(urgency) ? URGENT_CHANNEL :
                ("low".equals(urgency) || "very-low".equals(urgency) ? QUIET_CHANNEL : NORMAL_CHANNEL);
        String title = item.getString("title");
        String message = item.getString("message");
        PendingIntent intent = openApp();
        android.net.Uri link = MainActivity.safeLink(item.optString("url"));
        if (link != null) {
            intent = PendingIntent.getActivity(this, id.hashCode(), new Intent(Intent.ACTION_VIEW, link),
                    PendingIntent.FLAG_IMMUTABLE);
        }
        manager.notify(id, 1, new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_alert)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(intent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build());
    }

    @Override public void onDestroy() {
        receiving = false;
        running = false;
        if (receiver != null) receiver.interrupt();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
