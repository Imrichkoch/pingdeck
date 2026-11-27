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
    final SharedPreferences prefs;

    State(Context context) {
        prefs = context.getSharedPreferences("pingdeck", Context.MODE_PRIVATE);
    }

    String base() { return prefs.getString("base", Api.DEFAULT_URL); }
    String name() { return prefs.getString("name", ""); }
    String status() { return prefs.getString("status", "Príjem je pozastavený."); }
    boolean paired() { return prefs.contains("token"); }
    boolean active() { return prefs.getBoolean("active", false); }

    void setStatus(String status) {
        if (!status.equals(status())) prefs.edit().putString("status", status).apply();
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
                .putString("status", "Spárované. Povoľ prijímanie upozornení.").remove("inbox").commit()) {
            throw new IllegalStateException("Informácie o párovaní sa nepodarilo uložiť.");
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
                .putString("status", "Telefón bol odpojený.").apply();
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
            throw new IllegalStateException("Správu sa nepodarilo uložiť.");
        }
    }
}
