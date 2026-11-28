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
    private static final int SCAN_QR = 11;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private State state;
    private LinearLayout content;
    private LinearLayout messages;
    private TextView status;
    private Button toggle;
    private EditText pairingServer;
    private EditText pairingCode;
    private Button pairingButton;
    private boolean showingInbox;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        state = new State(this);
        state.prefs.registerOnSharedPreferenceChangeListener(this);
        render();
        if (saved == null) handlePairingIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePairingIntent(intent);
    }

    private void handlePairingIntent(Intent intent) {
        if (Intent.ACTION_VIEW.equals(intent.getAction())) confirmPairingLink(intent.getDataString());
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCAN_QR && result == RESULT_OK && data != null) {
            confirmPairingLink(data.getStringExtra("link"));
        }
    }

    private void confirmPairingLink(String rawLink) {
        PairingLink link = PairingLink.parse(rawLink);
        if (link == null || state.paired()) {
            new AlertDialog.Builder(this)
                    .setMessage(link == null ? R.string.invalid_pairing_link : R.string.pair_already_connected)
                    .setPositiveButton(android.R.string.ok, null)
                    .show();
            return;
        }
        if (pairingButton == null || !pairingButton.isEnabled()) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.confirm_pairing)
                .setMessage(getString(R.string.confirm_pairing_server, link.server))
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.pair_phone, (dialog, which) -> {
                    if (state.paired() || !pairingButton.isEnabled()) return;
                    pairingServer.setText(link.server);
                    pairingCode.setText(link.code);
                    pairingButton.performClick();
                })
                .show();
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
        if (Build.VERSION.SDK_INT >= 33) {
            Button language = button(getString(R.string.change_language), false);
            add(content, language, 14);
            language.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_APP_LOCALE_SETTINGS,
                    Uri.parse("package:" + getPackageName()))));
        }
    }

    private void pairingView() {
        add(content, text(getString(R.string.connect_phone), 38, INK, true), 26);
        String description = state.statusReason() == State.Status.REVOKED ? state.status() :
                getString(R.string.pair_instructions);
        add(content, text(description, 16, MUTED, false), 8);
        if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA)) {
            Button scan = button(getString(R.string.scan_qr), true);
            add(content, scan, 16);
            scan.setOnClickListener(view -> startActivityForResult(new Intent(this, QrActivity.class), SCAN_QR));
        }
        LinearLayout card = card();
        add(content, card, 21);
        add(card, text(getString(R.string.server_address), 14, INK, true), 0);
        EditText server = input("https://", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(state.base());
        add(card, server, 6);
        add(card, text(getString(R.string.pair_code), 14, INK, true), 12);
        EditText code = input(getString(R.string.code_hint), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        add(card, code, 6);

        TextView feedback = text("", 14, ERROR, false);
        Button pair = button(getString(R.string.pair_phone), false);
        pairingServer = server;
        pairingCode = code;
        pairingButton = pair;
        add(card, pair, 16);
        add(card, feedback, 9);
        pair.setOnClickListener(view -> {
            final Api api;
            try { api = new Api(this, server.getText().toString()); }
            catch (IllegalArgumentException error) { feedback.setText(error.getMessage()); return; }
            String value = code.getText().toString().trim();
            if (!value.matches("[A-Za-z0-9_-]{22}")) {
                feedback.setText(getString(R.string.invalid_code));
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
                        feedback.setText(error instanceof Api.Failure ? error.getMessage() : getString(R.string.pair_error));
                    });
                }
            });
        });
        Button panel = button(getString(R.string.open_dashboard), false);
        add(content, panel, 15);
        panel.setOnClickListener(view -> {
            try { open(safeLink(new Api(this, server.getText().toString()).base + "/app#zariadenia")); }
            catch (IllegalArgumentException error) { feedback.setText(error.getMessage()); }
        });
    }

    private void inboxView() {
        add(content, text(getString(R.string.received_messages), 36, INK, true), 26);
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
                state.setStatus(State.Status.PAUSED);
                stopService(new Intent(this, ReceiverService.class));
            } else {
                enableReceiving();
            }
        });
        add(content, text(getString(R.string.local_history), 19, INK, true), 22);
        messages = column();
        add(content, messages, 0);
        Button panel = button(getString(R.string.open_dashboard), false);
        add(content, panel, 19);
        panel.setOnClickListener(view -> open(safeLink(state.base() + "/app")));
        Button unlink = button(getString(R.string.disconnect_phone), false);
        add(content, unlink, 8);
        unlink.setOnClickListener(view -> new AlertDialog.Builder(this)
                .setTitle(getString(R.string.disconnect_question))
                .setMessage(getString(R.string.disconnect_description))
                .setNegativeButton(getString(R.string.cancel), null)
                .setPositiveButton(getString(R.string.disconnect), (dialog, which) -> disconnect(unlink)).show());
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
                    try { new Api(this, state.base()).call("DELETE", "device", token, null); }
                    catch (Api.Failure response) { if (response.status != 401) throw response; }
                }
                state.unpair();
            } catch (Exception error) {
                state.setStatus(State.Status.DISCONNECT_FAILED);
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
        state.setStatus(State.Status.CONNECTING);
        startForegroundService(new Intent(this, ReceiverService.class));
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code != PERMISSION || !state.paired()) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) startListening();
        else {
            state.setStatus(State.Status.PERMISSION);
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
        toggle.setText(state.active() ? getString(R.string.pause_receiving) : getString(R.string.enable_receiving));
    }

    private void updateHistory() {
        if (!showingInbox || messages == null) return;
        messages.removeAllViews();
        JSONArray rows = state.inbox();
        if (rows.length() == 0) {
            add(messages, text(getString(R.string.empty_history), 15, MUTED, false), 8);
            return;
        }
        DateFormat dates = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT,
                getResources().getConfiguration().getLocales().get(0));
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
                Button follow = button(getString(R.string.open_link), false);
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
                new AlertDialog.Builder(this).setMessage(getString(R.string.browser_missing)).setPositiveButton("OK", null).show();
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
