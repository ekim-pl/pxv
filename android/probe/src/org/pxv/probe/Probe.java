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

    private JSONObject observation() throws Exception {
        JSONObject result = new JSONObject();
        result.put("schema_version", 1);
        result.put("uid", Process.myUid());
        result.put("request_succeeded", false);
        result.put("connection_observed", false);
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        result.put("vpn_active", capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
        return result;
    }

    private HttpsURLConnection connection() throws Exception {
        URL url = new URL(endpoint);
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) {
            throw new IllegalArgumentException("An approved HTTPS endpoint is required");
        }
        HttpsURLConnection result = (HttpsURLConnection) url.openConnection();
        result.setConnectTimeout(15000);
        result.setReadTimeout(15000);
        result.setInstanceFollowRedirects(false);
        result.setRequestProperty("Accept", "application/json");
        result.setRequestProperty("User-Agent", "pxv-network-probe/1");
        return result;
    }

    private String responseAddress(HttpsURLConnection connection) throws Exception {
        if (connection.getResponseCode() != 200) throw new IllegalStateException("Unexpected endpoint response");
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
        String address = new JSONObject(response.toString("UTF-8")).getString("ip");
        if (address.length() > 64) throw new IllegalStateException("Invalid address size");
        return address;
    }

    @Override public void onStart() {
        JSONObject result = new JSONObject();
        HttpsURLConnection connection = null;
        try {
            result = observation();
            connection = connection();
            connection.connect();
            result.put("connection_observed", true);
            result.put("egress_ip", responseAddress(connection));
            result.put("request_succeeded", true);
        } catch (Exception failure) {
            try { result.put("error_type", failure.getClass().getSimpleName()); }
            catch (Exception ignored) { }
        } finally {
            if (connection != null) connection.disconnect();
            Bundle output = new Bundle();
            output.putString("pxv_json", result.toString());
            finish(0, output);
        }
    }
}
