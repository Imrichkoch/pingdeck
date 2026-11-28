package cloud.raizenko.pingdeck;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class QrActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private static final int CAMERA_PERMISSION = 1;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private SurfaceView preview;
    private TextView instruction;
    private Camera camera;
    private Camera.Size size;
    private boolean resumed;
    private boolean surfaceReady;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setTitle(R.string.scan_qr);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setFitsSystemWindows(true);
        instruction = new TextView(this);
        instruction.setText(R.string.scan_instruction);
        instruction.setTextSize(17);
        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        instruction.setPadding(padding, padding, padding, padding);
        layout.addView(instruction);
        preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request != CAMERA_PERMISSION) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) startCamera();
        else instruction.setText(R.string.scan_permission_denied);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        startCamera();
    }

    @Override protected void onPause() {
        resumed = false;
        releaseCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        startCamera();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        releaseCamera();
    }

    private void startCamera() {
        if (!resumed || !surfaceReady || camera != null ||
                checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            int rear = -1;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int index = 0; index < Camera.getNumberOfCameras(); index++) {
                Camera.getCameraInfo(index, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                    rear = index;
                    break;
                }
            }
            if (rear < 0) {
                instruction.setText(R.string.scan_unavailable);
                return;
            }
            camera = Camera.open(rear);
            Camera.Parameters parameters = camera.getParameters();
            parameters.setPreviewFormat(ImageFormat.NV21);
            for (Camera.Size candidate : parameters.getSupportedPreviewSizes()) {
                if (candidate.width == 1280 && candidate.height == 720) {
                    parameters.setPreviewSize(1280, 720);
                    break;
                }
            }
            if (parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(parameters);
            size = camera.getParameters().getPreviewSize();
            camera.setDisplayOrientation(info.orientation);
            camera.setPreviewDisplay(preview.getHolder());
            camera.startPreview();
            camera.setOneShotPreviewCallback(this);
        } catch (RuntimeException | IOException error) {
            releaseCamera();
            instruction.setText(R.string.scan_unavailable);
        }
    }

    private void releaseCamera() {
        if (camera == null) return;
        Camera previous = camera;
        camera = null;
        previous.release();
    }

    @Override public void onPreviewFrame(byte[] data, Camera source) {
        if (camera != source || decoder.isShutdown()) return;
        int width = size.width;
        int height = size.height;
        decoder.execute(() -> {
            String value = decode(data, width, height);
            runOnUiThread(() -> {
                if (camera != source || isFinishing()) return;
                if (PairingLink.parse(value) != null) {
                    setResult(RESULT_OK, new Intent().putExtra("link", value));
                    finish();
                    return;
                }
                if (value != null) instruction.setText(R.string.invalid_pairing_link);
                preview.postDelayed(() -> {
                    if (camera == source) source.setOneShotPreviewCallback(this);
                }, 150);
            });
        });
    }

    static String decode(byte[] data, int width, int height) {
        if (data == null || data.length < width * height) return null;
        try {
            PlanarYUVLuminanceSource frame = new PlanarYUVLuminanceSource(data,
                    width, height, 0, 0, width, height, false);
            return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(frame))).getText();
        } catch (ReaderException noQr) {
            return null;
        }
    }
}
