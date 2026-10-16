package org.pxv.setup;

import android.app.Instrumentation;
import android.os.Bundle;
import android.os.LocaleList;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;

/** One measurement in a fresh process, using public configuration APIs only. */
public final class LocaleObserver extends Instrumentation {
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            JSONObject observation = new JSONObject();
            observation.put("schema_version", 1);
            observation.put("uid", Process.myUid());
            observation.put("user_id", Process.myUid() / 100000);
            LocaleList locales = getTargetContext().getResources().getConfiguration().getLocales();
            if (locales.isEmpty() || locales.size() > 32) throw new IllegalStateException();
            JSONArray tags = new JSONArray();
            for (int i = 0; i < locales.size(); i++) tags.put(locales.get(i).toLanguageTag());
            observation.put("locales", tags);
            result.putString("pxv_json", observation.toString());
            finish(0, result);
        } catch (Exception error) {
            // No arbitrary diagnostics or device data leave the helper.
            finish(1, result);
        }
    }
}
