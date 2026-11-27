package cloud.raizenko.pingdeck;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity implements SharedPreferences.OnSharedPreferenceChangeListener {
    private static final int CANVAS = Color.rgb(245, 242, 234);
    private static final int PAPER = Color.rgb(255, 252, 245);
    private static final int INK = Color.rgb(33, 30, 26);
    private static final int MUTED = Color.rgb(98, 94, 84);
    private static final int LINE = Color.rgb(215, 208, 192);
    private static final int ACCENT = Color.rgb(255, 117, 76);
    private static final int ERROR = Color.rgb(160, 40, 22);
    private static final int PERMISSION = 10;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private State state;
    private LinearLayout content;
    private LinearLayout messages;
    private TextView status;
    private Button toggle;
    private boolean showingInbox;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        state = new State(this);
        state.prefs.registerOnSharedPreferenceChangeListener(this);
        render();
    }

    @Override protected void onResume() {
        super.onResume();
        if (state.paired()) {
            if (state.active() && !ReceiverService.isReceiving() && ReceiverService.hasPermission(this)) startListening();
            updateStatus();
        }
    }

    @Override protected void onDestroy() {
        state.prefs.unregisterOnSharedPreferenceChangeListener(this);
        io.shutdown();
        super.onDestroy();
    }

    private void render() {
        showingInbox = state.paired();
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(CANVAS);
        scroll.setFillViewport(true);
        content = column();
        content.setPadding(dp(22), dp(22), dp(22), dp(36));
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setOnApplyWindowInsetsListener((view, window) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets systemBars = window.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            } else {
                view.setPadding(window.getSystemWindowInsetLeft(), window.getSystemWindowInsetTop(),
                        window.getSystemWindowInsetRight(), window.getSystemWindowInsetBottom());
            }
            return window;
        });
        setContentView(scroll);
        scroll.requestApplyInsets();
        TextView brand = text("▮▰▮   PingDeck", 20, INK, true);
        add(content, brand, 0);
        if (showingInbox) inboxView();
        else pairingView();
    }

    private void pairingView() {
        add(content, text("Pripoj telefón", 38, INK, true), 26);
        String description = state.status().startsWith("Odber bol") ? state.status() :
                "V paneli otvor Zariadenia, vytvor Android kód a vlož ho sem.";
        add(content, text(description, 16, MUTED, false), 8);
        LinearLayout card = card();
        add(content, card, 21);
        add(card, text("HTTPS adresa servera", 14, INK, true), 0);
        EditText server = input("https://", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(state.base());
        add(card, server, 6);
        add(card, text("Jednorazový párovací kód", 14, INK, true), 12);
        EditText code = input("Kód z panela", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        add(card, code, 6);

        TextView feedback = text("", 14, ERROR, false);
        Button pair = button("Spárovať telefón", true);
        add(card, pair, 16);
        add(card, feedback, 9);
        pair.setOnClickListener(view -> {
            final Api api;
            try { api = new Api(server.getText().toString()); }
            catch (IllegalArgumentException error) { feedback.setText(error.getMessage()); return; }
            String value = code.getText().toString().trim();
            if (!value.matches("[A-Za-z0-9_-]{22}")) {
                feedback.setText("Vlož celý párovací kód.");
                return;
            }
            feedback.setText("");
            pair.setEnabled(false);
            io.execute(() -> {
                try {
                    JSONObject result = api.call("POST", "pair", null, new JSONObject().put("code", value));
                    state.pair(api.base, result.getString("name"), result.getString("token"));
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        render();
                        enableReceiving();
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        pair.setEnabled(true);
                        feedback.setText(error instanceof Api.Failure ? error.getMessage() : "Párovanie sa nepodarilo. Skontroluj adresu a pripojenie.");
                    });
                }
            });
        });
        Button panel = button("Otvoriť webový panel ↗", false);
        add(content, panel, 15);
        panel.setOnClickListener(view -> {
            try { open(safeLink(new Api(server.getText().toString()).base + "/app#zariadenia")); }
            catch (IllegalArgumentException error) { feedback.setText(error.getMessage()); }
        });
    }

    private void inboxView() {
        add(content, text("Doručené správy", 36, INK, true), 26);
        LinearLayout connection = card();
        add(content, connection, 15);
        add(connection, text(state.name(), 18, INK, true), 0);
        status = text("", 15, MUTED, false);
        add(connection, status, 4);
        toggle = button("", true);
        add(connection, toggle, 13);
        toggle.setOnClickListener(view -> {
            if (state.active()) {
                state.setActive(false);
                state.setStatus("Príjem je pozastavený.");
                stopService(new Intent(this, ReceiverService.class));
            } else {
                enableReceiving();
            }
        });
        add(content, text("História v tomto telefóne", 19, INK, true), 22);
        messages = column();
        add(content, messages, 0);
        Button panel = button("Otvoriť webový panel ↗", false);
        add(content, panel, 19);
        panel.setOnClickListener(view -> open(safeLink(state.base() + "/app")));
        Button unlink = button("Odpojiť telefón", false);
        add(content, unlink, 8);
        unlink.setOnClickListener(view -> new AlertDialog.Builder(this)
                .setTitle("Odpojiť telefón?")
                .setMessage("Príjem sa zastaví a história v telefóne sa vymaže.")
                .setNegativeButton("Zrušiť", null)
                .setPositiveButton("Odpojiť", (dialog, which) -> disconnect(unlink)).show());
        updateStatus();
        updateHistory();
    }

    private void disconnect(Button button) {
        button.setEnabled(false);
        state.setActive(false);
        stopService(new Intent(this, ReceiverService.class));
        io.execute(() -> {
            try {
                String token;
                try { token = state.token(); }
                catch (Exception lostKey) { token = null; }
                if (token != null) {
                    try { new Api(state.base()).call("DELETE", "device", token, null); }
                    catch (Api.Failure response) { if (response.status != 401) throw response; }
                }
                state.unpair();
            } catch (Exception error) {
                state.setStatus("Server je nedostupný. Skús odpojenie znova.");
                runOnUiThread(() -> button.setEnabled(true));
            }
        });
    }

    private void enableReceiving() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION);
            return;
        }
        if (!ReceiverService.hasPermission(this)) {
            openNotificationSettings();
            return;
        }
        startListening();
    }

    private void startListening() {
        state.setActive(true);
        state.setStatus("Pripájam sa k serveru…");
        startForegroundService(new Intent(this, ReceiverService.class));
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code != PERMISSION || !state.paired()) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) startListening();
        else {
            state.setStatus("Povoľ upozornenia, aby telefón mohol prijímať správy.");
            if (!shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) openNotificationSettings();
        }
    }

    private void openNotificationSettings() {
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    private void updateStatus() {
        if (!showingInbox || status == null) return;
        status.setText(state.status());
        toggle.setText(state.active() ? "Pozastaviť príjem" : "Zapnúť príjem");
    }

    private void updateHistory() {
        if (!showingInbox || messages == null) return;
        messages.removeAllViews();
        JSONArray rows = state.inbox();
        if (rows.length() == 0) {
            add(messages, text("Doručené upozornenia sa zobrazia tu.", 15, MUTED, false), 8);
            return;
        }
        DateFormat dates = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT);
        for (int index = 0; index < rows.length(); index++) {
            JSONObject entry = rows.optJSONObject(index);
            if (entry == null) continue;
            LinearLayout item = card();
            add(messages, item, 8);
            add(item, text(entry.optString("title"), 17, INK, true), 0);
            add(item, text(entry.optString("message"), 15, INK, false), 4);
            add(item, text(dates.format(new Date(entry.optLong("created"))), 12, MUTED, false), 9);
            Uri link = safeLink(entry.optString("url"));
            if (link != null) {
                Button follow = button("Otvoriť odkaz ↗", false);
                add(item, follow, 10);
                follow.setOnClickListener(view -> open(link));
            }
        }
    }

    @Override public void onSharedPreferenceChanged(SharedPreferences preferences, String key) {
        if ("token".equals(key) && showingInbox != state.paired()) render();
        else if ("inbox".equals(key)) updateHistory();
        else if ("status".equals(key) || "active".equals(key)) updateStatus();
    }

    static Uri safeLink(String value) {
        Uri uri = Uri.parse(value);
        if (uri.getHost() == null || uri.getUserInfo() != null) return null;
        return "https".equals(uri.getScheme()) || "http".equals(uri.getScheme()) ? uri : null;
    }

    private void open(Uri uri) {
        if (uri != null) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (android.content.ActivityNotFoundException error) {
                new AlertDialog.Builder(this).setMessage("Prehliadač nie je dostupný.").setPositiveButton("OK", null).show();
            }
        }
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout card() {
        LinearLayout layout = column();
        layout.setBackground(background(PAPER, LINE));
        layout.setPadding(dp(16), dp(16), dp(16), dp(16));
        return layout;
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button button(String value, boolean primary) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextSize(15);
        button.setTextColor(INK);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setMinHeight(dp(48));
        button.setBackground(background(primary ? ACCENT : PAPER, primary ? INK : LINE));
        return button;
    }

    private EditText input(String hint, int type) {
        EditText edit = new EditText(this);
        edit.setSingleLine(true);
        edit.setInputType(type);
        edit.setTextSize(16);
        edit.setHint(hint);
        edit.setPadding(dp(11), dp(11), dp(11), dp(11));
        edit.setBackground(background(PAPER, LINE));
        return edit;
    }

    private GradientDrawable background(int color, int outline) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setStroke(dp(1), outline);
        shape.setCornerRadius(dp(11));
        return shape;
    }

    private void add(LinearLayout parent, View child, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(top);
        parent.addView(child, params);
    }

    private int dp(int amount) { return Math.round(amount * getResources().getDisplayMetrics().density); }
}
