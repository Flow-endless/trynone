package com.huyingxxi.deepseek.multimodal;

import org.json.JSONObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.*;

/**
 * 调用 {@code scripts/video_analyze.py}，供 {@link VideoController} 与 {@link VideoInsightController} 共用。
 */
@Component
public class VideoPythonClient {

    private static final Logger log = LoggerFactory.getLogger(VideoPythonClient.class);

    @Value("${multimodal.vision.python-cmd:python}")
    private String pythonCmd;

    @Value("${multimodal.video.script-path:scripts/video_analyze.py}")
    private String scriptPath;

    @Value("${multimodal.vision.yolo-model:yolov8n.pt}")
    private String yoloModel;

    @Value("${multimodal.vision.yolo-confidence:0.18}")
    private double yoloConfidence;

    /** 仅视频抽帧；若在 [0.01, 0.99] 内则覆盖 vision 阈值，否则沿用图片侧配置。 */
    @Value("${multimodal.video.yolo-confidence:-1}")
    private double videoYoloConfidence;

    @Value("${multimodal.vision.yolo-imgsz:640}")
    private int yoloImgsz;

    @Value("${multimodal.vision.yolo-download-timeout-seconds:300}")
    private int yoloDownloadTimeoutSeconds;

    @Value("${multimodal.vision.yolo-assets-tag:v8.4.0}")
    private String yoloAssetsTag;

    @Value("${multimodal.video.infer-timeout-seconds:900}")
    private int inferTimeoutSeconds;

    @Value("${multimodal.audio.hf-endpoint:}")
    private String hfEndpoint;

    @Value("${multimodal.audio.whisper-model:tiny}")
    private String whisperModel;

    /** 与音频转写一致：视频 ASR 繁转简（OpenCC），见 multimodal.audio.whisper-simplified-zh */
    @Value("${multimodal.audio.whisper-simplified-zh:true}")
    private boolean whisperSimplifiedZh;

    /** faster-whisper beam，1 最快，≤5；见环境变量 WHISPER_BEAM_SIZE */
    @Value("${multimodal.video.whisper-beam-size:1}")
    private int videoWhisperBeamSize;

    /** YOLO 抽帧上限（40–120），略减可加快长视频 bundle */
    @Value("${multimodal.video.yolo-max-samples:80}")
    private int videoYoloMaxSamples;

    /**
     * @param task detect | keyframes | report | asr | bundle（一次输出 detect+keyframes+asr）
     */
    public Map<String, Object> run(String task, Path filePath, String lang) throws Exception {
        Path script = MultimodalPathUtil.resolveScriptPath(scriptPath);
        List<String> cmd = new ArrayList<>();
        cmd.add(pythonCmd);
        cmd.add(script.toString());
        cmd.add("--task");
        cmd.add(task);
        cmd.add("--input");
        cmd.add(filePath.toAbsolutePath().toString());
        cmd.add("--model");
        cmd.add(yoloModel);
        double c = yoloConfidence;
        if (videoYoloConfidence >= 0.01 && videoYoloConfidence <= 0.99) {
            c = videoYoloConfidence;
        }
        if (c < 0.01) {
            c = 0.01;
        }
        if (c > 0.99) {
            c = 0.99;
        }
        cmd.add("--conf");
        cmd.add(String.format(Locale.ROOT, "%.4f", c));
        int iz = yoloImgsz;
        if (iz < 320) {
            iz = 320;
        }
        if (iz > 1280) {
            iz = 1280;
        }
        cmd.add("--yolo-imgsz");
        cmd.add(String.valueOf(iz));
        cmd.add("--lang");
        cmd.add(lang == null ? "zh-CN" : lang);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        Map<String, String> env = pb.environment();
        env.put("PYTHONIOENCODING", "utf-8");
        env.put("PYTHONUNBUFFERED", "1");
        env.put("YOLO_DOWNLOAD_TIMEOUT_S", String.valueOf(Math.max(60, yoloDownloadTimeoutSeconds)));
        env.put("ULTRALYTICS_ASSETS_TAG", yoloAssetsTag);
        env.put("HF_ENDPOINT", "https://hf-mirror.com");
        env.put("KMP_DUPLICATE_LIB_OK", "TRUE");
        env.put("WHISPER_MODEL", whisperModel == null ? "tiny" : whisperModel.trim());
        env.put("WHISPER_DEVICE", "cpu");
        env.put("WHISPER_COMPUTE_TYPE", "int8");
        env.put("WHISPER_SIMPLIFIED_ZH", whisperSimplifiedZh ? "1" : "0");
        int beam = videoWhisperBeamSize;
        if (beam < 1) {
            beam = 1;
        }
        if (beam > 5) {
            beam = 5;
        }
        env.put("WHISPER_BEAM_SIZE", String.valueOf(beam));
        int yms = videoYoloMaxSamples;
        if (yms < 40) {
            yms = 40;
        }
        if (yms > 120) {
            yms = 120;
        }
        env.put("VIDEO_YOLO_MAX_SAMPLES", String.valueOf(yms));
        if (StringUtils.hasText(hfEndpoint)) {
            env.put("HF_ENDPOINT", hfEndpoint.trim());
        }

        log.info("[video][{}] start python: {}", task, String.join(" ", cmd));
        Process p = pb.start();

        long startedAt = System.currentTimeMillis();
        ExecutorService ioPool = Executors.newFixedThreadPool(2);
        Future<String> outFuture = ioPool.submit(() -> readAll(p.getInputStream()));
        // Stderr 必须持续消费，否则会灌满管道导致子进程阻塞；同时限制缓存体积避免巨量日志撑爆堆
        Future<String> errFuture = ioPool.submit(() -> readAllCapped(p.getErrorStream(), 512 * 1024));
        int timeout = Math.max(60, inferTimeoutSeconds);
        try {
            boolean finished = p.waitFor(timeout, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                throw new IllegalStateException("video python timeout after " + timeout + "s");
            }
            String out = waitStream(outFuture);
            String err = waitStream(errFuture);
            log.info("[video][{}] python exit={}, outLen={}, errLen={}", task, p.exitValue(), out.length(), err.length());
            if (p.exitValue() != 0) {
                throw new IllegalStateException("python exit=" + p.exitValue() + ", err=" + err);
            }
            JSONObject json = new JSONObject(out);
            if (json.has("error")) {
                throw new IllegalStateException(json.optString("error"));
            }
            Map<String, Object> map = json.toMap();
            map.putIfAbsent("backend", "python-video");
            map.put("elapsedMs", System.currentTimeMillis() - startedAt);
            return map;
        } finally {
            ioPool.shutdownNow();
        }
    }

    private String waitStream(Future<String> future) throws IOException {
        try {
            return future.get(120, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            throw new IOException("read process output timeout", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw new IOException("read process output failed: " + cause.getMessage(), cause);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("read process output interrupted", e);
        }
    }

    private String readAll(InputStream in) throws IOException {
        return readAllCapped(in, Integer.MAX_VALUE);
    }

    /**
     * 读取流直到 EOF。超过 maxKeep 的字节仍会从底层读取并丢弃，避免子进程因管道满而阻塞。
     */
    private String readAllCapped(InputStream in, int maxKeep) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(maxKeep, 65536));
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) {
            if (out.size() < maxKeep) {
                int room = maxKeep - out.size();
                out.write(buf, 0, Math.min(n, room));
            }
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
