package cloud.raizenko.pingdeck;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

final class Api {
    static final String DEFAULT_URL = "https://raizenko.cloud/pingdeck";
    final String base;
    private final Context context;

    Api(Context context, String base) {
        this.context = context;
        String value = base.trim().replaceAll("/+$", "");
        try {
            URI uri = URI.create(value).normalize();
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                    uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException();
            }
            this.base = uri.toASCIIString();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(context.getString(R.string.invalid_server));
        }
    }

    JSONObject call(String method, String path, String token, JSONObject data) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(base + "/api/mobile/" + path).toURL().openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(28_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Language", context.getString(R.string.language_code));
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (data != null) {
                byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream stream = connection.getOutputStream()) {
                    stream.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (status == 204) return new JSONObject();
            if (status < 200 || status >= 300) {
                JSONObject result;
                try { result = read(connection.getErrorStream()); }
                catch (Exception error) { result = new JSONObject(); }
                throw new Failure(status, result.optString("error", context.getString(R.string.server_error, status)));
            }
            return read(connection.getInputStream());
        } finally {
            connection.disconnect();
        }
    }

    private JSONObject read(InputStream input) throws Exception {
        if (input == null) return new JSONObject();
        try (InputStream stream = input; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() + count > 512 * 1024) throw new IOException(context.getString(R.string.large_response));
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    static final class Failure extends IOException {
        final int status;
        Failure(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
