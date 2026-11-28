package cloud.raizenko.pingdeck;

import java.net.URI;

final class PairingLink {
    private static final String SUFFIX = "/android/pair";
    final String server;
    final String code;

    private PairingLink(String server, String code) {
        this.server = server;
        this.code = code;
    }

    static PairingLink parse(String value) {
        if (value == null || value.length() > 2048) return null;
        try {
            URI link = URI.create(value);
            String path = link.getRawPath();
            String fragment = link.getRawFragment();
            if (!"https".equals(link.getScheme()) || link.getHost() == null || link.getUserInfo() != null ||
                    link.getRawQuery() != null || link.getPort() == 0 || link.getPort() > 65535 ||
                    path == null || !path.matches("(?:/[a-zA-Z0-9_-]+)*" + SUFFIX) ||
                    fragment == null || !fragment.matches("code=[a-zA-Z0-9_-]{22}")) return null;
            String base = path.substring(0, path.length() - SUFFIX.length());
            return new PairingLink("https://" + link.getRawAuthority() + base, fragment.substring(5));
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }
}
