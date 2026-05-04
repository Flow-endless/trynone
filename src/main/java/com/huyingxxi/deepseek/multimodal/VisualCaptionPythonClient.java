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
import java.util.*;
import java.util.concurrent.*;

/**
 * 调用 {@code scripts/video_visual_captions.py}（BLIP 抽帧描述），为「无语音/需行为级画面理解」提供素材。
 */
@Component
public class VisualCaptionPythonClient {

    private static final Logger log = LoggerFactory.getLogger(VisualCaptionPythonClient.class);

    @Value("${multimodal.vision.python-cmd:python}")
    private String pythonCmd;

    @Value("${multimodal.video.visual-caption-script-path:scripts/video_visual_captions.py}")
    private String scriptPath;

    @Value("${multimodal.video.visual-caption-enabled:true}")
    private boolean enabled;

    @Value("${multimodal.video.visual-caption-max-frames:8}")
    private int maxFrames;

    @Value("${multimodal.video.visual-caption-timeout-seconds:420}")
    private int timeoutSeconds;

    @Value("${multimodal.audio.hf-endpoint:}")
    private String hfEndpoint;

    public boolean isEnabled() {
        return enabled;
    }

    /**
     * @return 含 engine / frames[{time,caption_en}] / note；失败时 note 说明原因，frames 可能为空
     */
    public Map<String, Object> run(Path videoFile) throws Exception {
        if (!enabled) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("engine", "disabled");
            m.put("frames", Collections.emptyList());
            m.put("note", "已在 application.yml 将 multimodal.video.visual-caption-enabled 设为 false");
            return m;
        }
        Path script = MultimodalPathUtil.resolveScriptPath(scriptPath);
        List<String> cmd = new ArrayList<>();
        cmd.add(pythonCmd);
        cmd.add(script.toString());
        cmd.add("--input");
        cmd.add(videoFile.toAbsolutePath().toString());
        cmd.add("--max-frames");
        cmd.add(String.valueOf(Math.max(2, Math.min(16, maxFrames))));

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        Map<String, String> env = pb.environment();
        env.put("PYTHONIOENCODING", "utf-8");
        env.put("PYTHONUNBUFFERED", "1");
        env.put("HF_ENDPOINT", "https://hf-mirror.com");
        if (StringUtils.hasText(hfEndpoint)) {
            env.put("HF_ENDPOINT", hfEndpoint.trim());
        }

        log.info("[video-caption] start: {}", String.join(" ", cmd));
        Process p = pb.start();
        long startedAt = System.currentTimeMillis();
        ExecutorService ioPool = Executors.newFixedThreadPool(2);
        Future<String> outFuture = ioPool.submit(() -> readAll(p.getInputStream()));
        Future<String> errFuture = ioPool.submit(() -> readAllCapped(p.getErrorStream(), 512 * 1024));
        int timeout = Math.max(60, timeoutSeconds);
        try {
            boolean finished = p.waitFor(timeout, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                throw new IllegalStateException("visual caption python timeout after " + timeout + "s");
            }
            String out = waitStream(outFuture);
            String err = waitStream(errFuture);
            log.info("[video-caption] exit={}, outLen={}, errLen={}", p.exitValue(), out.length(), err.length());
            if (p.exitValue() != 0) {
                throw new IllegalStateException("python exit=" + p.exitValue() + ", err=" + err + ", out=" + out.substring(0, Math.min(400, out.length())));
            }
            JSONObject json = new JSONObject(out);
            if (json.has("error")) {
                throw new IllegalStateException(json.optString("error"));
            }
            Map<String, Object> map = json.toMap();
            map.putIfAbsent("backend", "python-visual-caption");
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
