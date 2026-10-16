package org.pxv.probe;

import android.app.Instrumentation;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Process;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

/** A short-lived, ordinary app UID probe. It never binds to an underlying network. */
public final class Probe extends Instrumentation {
    private String endpoint;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        endpoint = arguments == null ? null : arguments.getString("endpoint");
        start();
    }

    @Override public void onStart() {
        JSONObject observation = new JSONObject();
        HttpsURLConnection connection = null;
        try {
            observation.put("schema_version", 1);
            observation.put("uid", Process.myUid());
            observation.put("request_succeeded", false);
            observation.put("connection_observed", false);
            ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
            observation.put("vpn_active", capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            URL url = new URL(endpoint);
            if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) {
                throw new IllegalArgumentException("An approved HTTPS endpoint is required");
            }
            connection = (HttpsURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "pxv-network-probe/1");
            connection.connect();
            observation.put("connection_observed", true);
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("Unexpected endpoint response");
            ByteArrayOutputStream response = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[1024];
                long deadline = android.os.SystemClock.elapsedRealtime() + 30000;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (response.size() + count > 65536 || android.os.SystemClock.elapsedRealtime() >= deadline) {
                        throw new IllegalStateException("Probe response exceeds its bounds");
                    }
                    response.write(buffer, 0, count);
                }
            }
            JSONObject body = new JSONObject(response.toString("UTF-8"));
            String address = body.getString("ip");
            if (address.length() > 64) throw new IllegalStateException("Invalid address size");
            observation.put("egress_ip", address);
            observation.put("request_succeeded", true);
        } catch (Exception failure) {
            // Return the exception type rather than URLs, accounts, or response data.
            try { observation.put("error_type", failure.getClass().getSimpleName()); }
            catch (Exception ignored) { }
        } finally {
            if (connection != null) connection.disconnect();
            Bundle result = new Bundle();
            result.putString("pxv_json", observation.toString());
            finish(0, result);
        }
    }
}
