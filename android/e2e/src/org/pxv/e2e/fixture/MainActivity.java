package org.pxv.e2e.fixture;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;
import java.io.InputStream;
import java.security.MessageDigest;

/** Disposable test UI. It deliberately leaves the Android picker to the operator. */
public final class MainActivity extends Activity {
    private SharedPreferences preferences;
    private EditText configuration;
    private Switch enabled;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("fixture", MODE_PRIVATE);
        setContentView(R.layout.main);
        configuration = findViewById(R.id.configuration);
        enabled = findViewById(R.id.enabled);
        status = findViewById(R.id.status);
        configuration.setText(preferences.getString("configuration", ""));
        enabled.setChecked(preferences.getBoolean("enabled", false));
        findViewById(R.id.save).setOnClickListener(view -> {
            String value = configuration.getText().toString();
            if (value.length() > 128 || !value.matches("[ -~]*")) {
                status.setText("Use at most 128 non-secret ASCII characters");
                return;
            }
            if (preferences.edit().putString("configuration", value)
                    .putBoolean("enabled", enabled.isChecked()).commit()) {
                status.setText("Saved synthetic configuration");
            } else {
                status.setText("Save failed");
            }
        });
        findViewById(R.id.import_file).setOnClickListener(view -> {
            Intent request = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            request.setType("*/*");
            request.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(request, 1);
        });
    }

    private static String documentDigest(InputStream input) throws Exception {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[4096];
            int count, size = 0;
            while ((count = input.read(buffer)) != -1) {
                size += count;
                if (size > 131072) throw new IllegalArgumentException();
                hash.update(buffer, 0, count);
            }
            StringBuilder digest = new StringBuilder();
            for (byte value : hash.digest()) digest.append(String.format("%02x", value & 255));
            return digest.toString();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 1 || result != RESULT_OK || data == null || data.getData() == null) return;
        try (InputStream input = getContentResolver().openInputStream(data.getData())) {
            if (input == null) throw new IllegalStateException();
            String digest = documentDigest(input);
            if (!preferences.edit().putString("import_sha256", digest.toString()).commit()) {
                throw new IllegalStateException();
            }
            status.setText("Imported SHA-256: " + digest);
        } catch (Exception failure) {
            status.setText("Import failed; select a synthetic document of at most 128 KiB");
        }
    }
}
