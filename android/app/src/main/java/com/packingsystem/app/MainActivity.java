package com.packingsystem.app;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // The barcode scanner uses the browser's getUserMedia() API rather than
    // a native Capacitor plugin, so the WebView needs to grant camera
    // permission requests itself — declaring android.permission.CAMERA in
    // the manifest alone isn't enough; without this override the page's
    // getUserMedia() call is silently denied.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
