package cloud.raizenko.pingdeck;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

final class State {
    private static final String KEY = "pingdeck.receiver";
    private static final int INBOX_LIMIT = 100;
    private final Context context;
    final SharedPreferences prefs;

    State(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences("pingdeck", Context.MODE_PRIVATE);
    }

    String base() { return prefs.getString("base", Api.DEFAULT_URL); }
    String name() { return prefs.getString("name", ""); }
    enum Status {
        PAUSED, PAIRED, DISCONNECTED, DISCONNECT_FAILED, CONNECTING, PERMISSION,
        KEY_MISSING, NOTIFICATIONS_DISABLED, READY, REVOKED, RECONNECTING
    }

    Status statusReason() {
        try { return Status.valueOf(prefs.getString("status", "PAUSED")); }
        catch (IllegalArgumentException legacyStatus) { return Status.PAUSED; }
    }

    String status() {
        int resource;
        switch (statusReason()) {
            case PAIRED: resource = R.string.state_paired; break;
            case DISCONNECTED: resource = R.string.state_disconnected; break;
            case DISCONNECT_FAILED: resource = R.string.state_disconnect_failed; break;
            case CONNECTING: resource = R.string.state_connecting; break;
            case PERMISSION: resource = R.string.state_permission; break;
            case KEY_MISSING: resource = R.string.state_key_missing; break;
            case NOTIFICATIONS_DISABLED: resource = R.string.state_notifications_disabled; break;
            case READY: resource = R.string.state_ready; break;
            case REVOKED: resource = R.string.state_revoked; break;
            case RECONNECTING: resource = R.string.state_reconnecting; break;
            default: resource = R.string.state_paused;
        }
        return context.getString(resource);
    }
    boolean paired() { return prefs.contains("token"); }
    boolean active() { return prefs.getBoolean("active", false); }

    void setStatus(Status status) {
        if (!status.name().equals(prefs.getString("status", ""))) prefs.edit().putString("status", status.name()).apply();
    }
    void setActive(boolean value) {
        if (active() != value) prefs.edit().putBoolean("active", value).apply();
    }

    String token() throws Exception {
        String saved = prefs.getString("token", "");
        if (saved.isEmpty()) return null;
        String[] parts = saved.split("\\.", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    void pair(String base, String name, String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString("base", base).putString("name", name).putString("token", value)
                .putString("status", Status.PAIRED.name()).remove("inbox").commit()) {
            throw new IllegalStateException(context.getString(R.string.save_pair_error));
        }
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey result = (SecretKey) store.getKey(KEY, null);
        if (result != null || !create) return result;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    void unpair() {
        prefs.edit().remove("token").remove("name").remove("inbox").remove("active")
                .putString("status", Status.DISCONNECTED.name()).apply();
    }

    JSONArray inbox() {
        try { return new JSONArray(prefs.getString("inbox", "[]")); }
        catch (JSONException error) { return new JSONArray(); }
    }

    boolean hasMessage(String id) {
        JSONArray messages = inbox();
        for (int index = 0; index < messages.length(); index++) {
            if (id.equals(messages.optJSONObject(index).optString("id"))) return true;
        }
        return false;
    }

    void saveMessage(JSONObject item) throws Exception {
        JSONArray previous = inbox();
        JSONArray messages = new JSONArray().put(item);
        for (int index = 0; index < previous.length() && index < INBOX_LIMIT - 1; index++) {
            messages.put(previous.getJSONObject(index));
        }
        if (!prefs.edit().putString("inbox", messages.toString()).commit()) {
            throw new IllegalStateException(context.getString(R.string.save_message_error));
        }
    }
}
