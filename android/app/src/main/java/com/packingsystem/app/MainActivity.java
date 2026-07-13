package com.packingsystem.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // The barcode scanner uses the browser's getUserMedia() API rather
    // than a native Capacitor plugin, so camera permission has two
    // layers here: the WebView's own permission request AND Android's
    // runtime permission. Granting the WebView request silently fails
    // unless the app already holds the runtime permission — so when the
    // page first asks for the camera, we pop Android's permission
    // dialog, park the WebView request, and answer it once the user
    // responds.
    private static final int CAMERA_PERMISSION_REQUEST = 4711;
    private PermissionRequest pendingWebViewRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (ContextCompat.checkSelfPermission(
                            MainActivity.this, Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        pendingWebViewRequest = request;
                        ActivityCompat.requestPermissions(
                                MainActivity.this,
                                new String[] { Manifest.permission.CAMERA },
                                CAMERA_PERMISSION_REQUEST);
                    }
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST && pendingWebViewRequest != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingWebViewRequest.grant(pendingWebViewRequest.getResources());
            } else {
                pendingWebViewRequest.deny();
            }
            pendingWebViewRequest = null;
        }
    }
}
