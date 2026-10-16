package org.pxv.e2e.fixture;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Process;
import org.json.JSONObject;

/** Read the fixture's actual per-user restored state; no fabricated backup result. */
public final class FixtureProbe extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SharedPreferences preferences = getTargetContext().getSharedPreferences("fixture", Context.MODE_PRIVATE);
            JSONObject observed = new JSONObject();
            observed.put("schema_version", 1);
            observed.put("uid", Process.myUid());
            observed.put("configuration", preferences.getString("configuration", ""));
            observed.put("enabled", preferences.getBoolean("enabled", false));
            observed.put("import_sha256", preferences.getString("import_sha256", ""));
            result.putString("pxv_json", observed.toString());
            finish(Activity.RESULT_OK, result);
        } catch (Exception failure) {
            result.putString("error", "Fixture observation failed");
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
