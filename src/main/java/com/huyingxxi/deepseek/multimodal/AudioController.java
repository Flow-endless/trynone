package com.huyingxxi.deepseek.multimodal;

import org.json.JSONObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

@RestController
@RequestMapping("/api/audio")
public class AudioController {

    private static final Logger log = LoggerFactory.getLogger(AudioController.class);

    @Value("${multimodal.audio.python-cmd:python}")
    private String pythonCmd;

    @Value("${multimodal.audio.script-path:scripts/audio_transcribe.py}")
    private String scriptPath;

    @Value("${multimodal.audio.whisper-model:tiny}")
    private String whisperModel;

    @Value("${multimodal.audio.infer-timeout-seconds:600}")
    private int inferTimeoutSeconds;

    /** 为 true 时调用 Python faster-whisper；失败则回退占位转写 */
    @Value("${multimodal.audio.use-python-asr:true}")
    private boolean usePythonAsr;

    @Value("${multimodal.audio.whisper-simplified-zh:true}")
    private boolean whisperSimplifiedZh;

    /** 传给 Python：HF_ENDPOINT，国内常用 https://hf-mirror.com */
    @Value("${multimodal.audio.hf-endpoint:}")
    private String hfEndpoint;

    @PostMapping(value = "/transcribe", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> transcribe(@RequestParam("file") MultipartFile file,
                                          @RequestParam(value = "lang", required = false) String lang) {
        validateFile(file);
        String targetLang = StringUtils.hasText(lang) ? lang : "zh-CN";
        String fileName = Optional.ofNullable(file.getOriginalFilename()).orElse("audio");

        if (usePythonAsr) {
            try {
                Path temp = saveToTemp(file, inferAudioSuffix(file));
                try {
                    return invokeTranscribe(temp, targetLang, fileName);
                } finally {
                    Files.deleteIfExists(temp);
                }
            } catch (Exception e) {
                log.warn("[audio] python ASR failed, fallback to heuristic", e);
                return buildHeuristicResponse(file, targetLang, fileName, e.getMessage());
            }
        }

        return buildHeuristicResponse(file, targetLang, fileName, null);
    }

    private Map<String, Object> invokeTranscribe(Path audioPath, String targetLang, String fileName)
            throws Exception {
        Path script = resolveScriptPath();
        List<String> cmd = new ArrayList<>();
        cmd.add(pythonCmd);
        cmd.add(script.toString());
        cmd.add("--input");
        cmd.add(audioPath.toAbsolutePath().toString());
        cmd.add("--lang");
        cmd.add(targetLang);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        Map<String, String> env = pb.environment();
        env.put("PYTHONIOENCODING", "utf-8");
        env.put("WHISPER_MODEL", whisperModel == null ? "tiny" : whisperModel.trim());
        env.put("WHISPER_DEVICE", "cpu");
        env.put("WHISPER_COMPUTE_TYPE", "int8");
        if (StringUtils.hasText(hfEndpoint)) {
            env.put("HF_ENDPOINT", hfEndpoint.trim());
            log.info("[audio] HF_ENDPOINT={}", hfEndpoint.trim());
        }
        env.put("HF_HUB_DOWNLOAD_TIMEOUT", "1200");
        env.put("WHISPER_SIMPLIFIED_ZH", whisperSimplifiedZh ? "1" : "0");

        log.info("[audio] script={}, start python: {}", script.toAbsolutePath(), String.join(" ", cmd));
        Process p = pb.start();

        long startedAt = System.currentTimeMillis();
        ExecutorService ioPool = Executors.newFixedThreadPool(2);
        Future<String> outFuture = ioPool.submit(() -> readAll(p.getInputStream()));
        Future<String> errFuture = ioPool.submit(() -> readAll(p.getErrorStream()));
        int timeout = Math.max(60, inferTimeoutSeconds);
        try {
            boolean finished = p.waitFor(timeout, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                throw new IllegalStateException("audio transcribe timeout after " + timeout + "s");
            }
            String out = waitStream(outFuture);
            String err = waitStream(errFuture);
            log.info("[audio] python finished: exit={}, outLen={}, errLen={}", p.exitValue(), out.length(), err.length());
            if (p.exitValue() != 0) {
                throw new IllegalStateException("python exit=" + p.exitValue() + ", err=" + err);
            }
            JSONObject json = new JSONObject(out);
            if (json.has("error")) {
                throw new IllegalStateException(json.optString("error"));
            }
            Map<String, Object> map = json.toMap();
            map.putIfAbsent("lang", targetLang);
            map.putIfAbsent("fileName", fileName);
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

    private Path resolveScriptPath() {
        return MultimodalPathUtil.resolveScriptPath(scriptPath);
    }

    private String inferAudioSuffix(MultipartFile file) {
        String name = file.getOriginalFilename();
        if (StringUtils.hasText(name)) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String ext = name.substring(dot).toLowerCase(Locale.ROOT);
                switch (ext) {
                    case ".mp3":
                    case ".wav":
                    case ".m4a":
                    case ".webm":
                    case ".ogg":
                    case ".flac":
                    case ".mp4":
                        return ext;
                    default:
                        break;
                }
            }
        }
        String ct = file.getContentType();
        if (StringUtils.hasText(ct)) {
            String c = ct.toLowerCase(Locale.ROOT);
            if (c.contains("webm")) {
                return ".webm";
            }
            if (c.contains("wav")) {
                return ".wav";
            }
            if (c.contains("mpeg") || c.contains("mp3")) {
                return ".mp3";
            }
            if (c.contains("mp4") || c.contains("m4a")) {
                return ".m4a";
            }
        }
        return ".wav";
    }

    private Path saveToTemp(MultipartFile file, String ext) throws IOException {
        Path temp = Files.createTempFile("audio-", ext);
        file.transferTo(temp.toFile());
        return temp;
    }

    private String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    private Map<String, Object> buildHeuristicResponse(MultipartFile file, String lang, String fileName, String pythonError) {
        long hash = MultimodalHeuristicUtil.stableFileHash(file);
        long kb = Math.max(1, file.getSize() / 1024);
        String text = buildTranscript(lang, fileName, kb, hash);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "heuristic-fallback");
        resp.put("lang", lang);
        resp.put("fileName", fileName);
        resp.put("text", text);
        resp.put("transcript", text);
        if (StringUtils.hasText(pythonError)) {
            String detail = truncate(pythonError, 1200);
            resp.put("errorDetail", detail);
            resp.put(
                    "warning",
                    "Python 未成功完成语音识别（下方为占位文字）。失败原因摘要：\n"
                            + detail
                            + "\n\n常见处理：1）在 venv 中执行 pip install -r requirements-audio.txt（可用清华镜像）；"
                            + "2）确认 application.yml 里 multimodal.audio.python-cmd 指向该 venv 的 python.exe；"
                            + "3）麦克风录制的 webm 若报错与 ffmpeg 相关，请安装 ffmpeg 或改用上传 wav/mp3。"
            );
        } else {
            resp.put("warning", "未接入真实 ASR 时的占位结果；可在 venv 中安装 faster-whisper 并检查 multimodal.audio 配置。");
        }
        return resp;
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        String t = s.replace("\r\n", "\n").trim();
        if (t.length() <= max) {
            return t;
        }
        return t.substring(0, max) + "…";
    }

    private String buildTranscript(String lang, String fileName, long kb, long hash) {
        if ("en-US".equalsIgnoreCase(lang)) {
            return "This is a fallback transcript for file \"" + fileName + "\". "
                    + "Audio size is approximately " + kb + " KB. "
                    + "Token " + (hash % 10000) + ". Install faster-whisper for real ASR.";
        }
        if ("ja-JP".equalsIgnoreCase(lang)) {
            return "フォールバック音声結果です。ファイル: " + fileName + "、サイズ: " + kb + "KB。";
        }
        if ("ko-KR".equalsIgnoreCase(lang)) {
            return "폴백 음성 결과입니다. 파일: " + fileName + ", 용량: " + kb + "KB.";
        }
        if ("fr-FR".equalsIgnoreCase(lang)) {
            return "Resultat ASR de secours. Fichier: " + fileName + ", taille: " + kb + "KB.";
        }
        return "这是后端占位语音识别结果（未成功运行 faster-whisper）。文件：" + fileName
                + "，大小约 " + kb + "KB。请执行: pip install -r requirements-audio.txt";
    }

    private void validateFile(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("音频文件不能为空");
        }
        if (file.getSize() > 50L * 1024 * 1024) {
            throw new IllegalArgumentException("音频文件过大，请控制在50MB以内");
        }
    }
}
