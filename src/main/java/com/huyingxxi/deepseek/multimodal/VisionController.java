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
import java.util.regex.Pattern;

@RestController
@RequestMapping("/api/vision")
public class VisionController {
    private static final Logger log = LoggerFactory.getLogger(VisionController.class);

    /** 至少两个连续 ASCII 拉丁字母（常见英文单词） */
    private static final Pattern OCR_ASCII_LATIN_WORD = Pattern.compile("[A-Za-z]{2,}");

    private final DeepSeekTranslateService translateService;

    public VisionController(DeepSeekTranslateService translateService) {
        this.translateService = translateService;
    }

    @Value("${multimodal.vision.python-cmd:python}")
    private String pythonCmd;

    @Value("${multimodal.vision.script-path:scripts/vision_infer.py}")
    private String scriptPath;

    @Value("${multimodal.vision.yolo-model:yolov8n.pt}")
    private String yoloModel;

    /** YOLO 检测置信度下限（0~1），与 vision_infer.py --conf 一致 */
    @Value("${multimodal.vision.yolo-confidence:0.18}")
    private double yoloConfidence;

    @Value("${multimodal.vision.ocr-lang:ch}")
    private String ocrLang;

    /** OCR 引擎：rapid=RapidOCR+ONNX（默认，Windows 推荐）；auto=先 rapid 再 paddle；paddle=PaddleOCR */
    @Value("${multimodal.vision.ocr-backend:rapid}")
    private String ocrBackend;

    @Value("${multimodal.vision.use-heuristic-fallback:false}")
    private boolean useHeuristicFallback;

    @Value("${multimodal.vision.infer-timeout-seconds:600}")
    private int inferTimeoutSeconds;

    @Value("${multimodal.vision.yolo-download-timeout-seconds:300}")
    private int yoloDownloadTimeoutSeconds;

    @Value("${multimodal.vision.yolo-assets-tag:v8.4.0}")
    private String yoloAssetsTag;

    /** YOLO 推理边长（320~1280） */
    @Value("${multimodal.vision.yolo-imgsz:640}")
    private int yoloImgsz;

    /** 仅 YOLO-World（*world*.pt）：追加英文类别，逗号分隔 */
    @Value("${multimodal.vision.yolo-world-extra-classes:}")
    private String yoloWorldExtraClasses;

    @PostMapping(value = "/yolo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> yolo(@RequestParam("file") MultipartFile file,
                                    @RequestParam(value = "mode", required = false) String mode) throws IOException {
        validateFile(file);
        log.info("[vision][yolo] request received: name={}, size={} bytes", file.getOriginalFilename(), file.getSize());
        try {
            Path temp = saveToTemp(file, inferImageSuffix(file));
            try {
                return invokePython("yolo", temp, StringUtils.hasText(mode) ? mode : "yolo");
            } finally {
                Files.deleteIfExists(temp);
            }
        } catch (Exception e) {
            log.warn("YOLO python inference failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("YOLO真实模型调用失败，请确认已安装Python依赖（ultralytics/opencv）并配置脚本路径", e);
            }
            return heuristicYolo(1280, 720, file, mode);
        }
    }

    @PostMapping(value = "/ocr", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> ocr(@RequestParam("file") MultipartFile file,
                                   @RequestParam(value = "lang", required = false) String lang) {
        validateFile(file);
        String targetLang = StringUtils.hasText(lang) ? lang : ocrLang;
        log.info("[vision][ocr] request received: name={}, size={} bytes, lang={}", file.getOriginalFilename(), file.getSize(), targetLang);
        try {
            Path temp = saveToTemp(file, inferImageSuffix(file));
            try {
                Map<String, Object> result = invokePython("ocr", temp, targetLang);
                result.putIfAbsent("lang", targetLang);
                enrichOcrWithTranslation(result);
                return result;
            } finally {
                Files.deleteIfExists(temp);
            }
        } catch (Exception e) {
            log.warn("OCR python inference failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException(
                        "OCR 调用失败。请在本项目 venv 中安装: pip install -r requirements-vision.txt "
                                + "（推荐 RapidOCR+ONNX，无需 PyTorch）。若需 PaddleOCR 再安装 paddlepaddle、paddleocr。",
                        e);
            }
            return heuristicOcr(file, targetLang);
        }
    }

    /**
     * Python 给出 ocrScript：
     * <ul>
     *   <li>{@code translate}：以外语为主 → 全文译为中文写入 {@code textZh}</li>
     *   <li>{@code cjk}：中文为主 → 若含外文片段（英/日/韩/西里尔等），另调用模型生成「外文 — 中文释义」列表写入 {@code textForeignZh}（并写入 {@code textEnglishZh} 同值以兼容旧前端）</li>
     * </ul>
     * 繁简转换在 Python 侧写入 {@code textSimplified}。
     */
    private void enrichOcrWithTranslation(Map<String, Object> result) {
        String script = result.get("ocrScript") != null ? String.valueOf(result.get("ocrScript")).trim() : "";

        if ("translate".equals(script)) {
            Object textObj = result.get("text");
            if (!(textObj instanceof String)) {
                return;
            }
            String text = ((String) textObj).trim();
            if (!StringUtils.hasText(text)) {
                return;
            }
            try {
                String zh = translateService.translateToChinese(text);
                if (StringUtils.hasText(zh)) {
                    result.put("textZh", zh);
                }
            } catch (Exception e) {
                log.warn("[vision][ocr] translate to Chinese failed: {}", e.getMessage());
            }
            return;
        }

        if ("cjk".equals(script)) {
            Object textObj = result.get("text");
            if (!(textObj instanceof String)) {
                return;
            }
            String text = ((String) textObj).trim();
            if (!StringUtils.hasText(text) || !ocrTextContainsForeignFragments(text)) {
                return;
            }
            boolean gotForeign = false;
            try {
                String foreignZh = translateService.translateForeignFragmentsInMixedOcr(text);
                if (StringUtils.hasText(foreignZh) && !isNoForeignOcrSupplement(foreignZh)) {
                    String trimmed = foreignZh.trim();
                    result.put("textForeignZh", trimmed);
                    result.put("textEnglishZh", trimmed);
                    gotForeign = true;
                }
            } catch (Exception e) {
                log.warn("[vision][ocr] foreign-in-mixed OCR supplement failed: {}", e.getMessage());
            }
            if (!gotForeign) {
                try {
                    String zh = translateService.translateToChinese(text);
                    if (StringUtils.hasText(zh)) {
                        result.put("textZh", zh);
                    }
                } catch (Exception e2) {
                    log.warn("[vision][ocr] fallback full translate after fragment failure: {}", e2.getMessage());
                }
            }
        }
    }

    /**
     * 是否含需释义的外文：ASCII 单词、拉丁扩展（如 é）、假名、谚文、西里尔、阿拉伯、泰文等。
     */
    private static boolean ocrTextContainsForeignFragments(String text) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        if (OCR_ASCII_LATIN_WORD.matcher(text).find()) {
            return true;
        }
        for (int i = 0; i < text.length(); i++) {
            if (isForeignScriptChar(text.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isForeignScriptChar(char c) {
        Character.UnicodeBlock b = Character.UnicodeBlock.of(c);
        if (b == Character.UnicodeBlock.BASIC_LATIN) {
            return false;
        }
        if (b == Character.UnicodeBlock.HIRAGANA
                || b == Character.UnicodeBlock.KATAKANA
                || b == Character.UnicodeBlock.KATAKANA_PHONETIC_EXTENSIONS
                || b == Character.UnicodeBlock.HANGUL_SYLLABLES
                || b == Character.UnicodeBlock.HANGUL_JAMO
                || b == Character.UnicodeBlock.HANGUL_COMPATIBILITY_JAMO
                || b == Character.UnicodeBlock.CYRILLIC
                || b == Character.UnicodeBlock.CYRILLIC_SUPPLEMENTARY
                || b == Character.UnicodeBlock.ARABIC
                || b == Character.UnicodeBlock.ARABIC_SUPPLEMENT
                || b == Character.UnicodeBlock.THAI
                || b == Character.UnicodeBlock.HEBREW
                || b == Character.UnicodeBlock.GREEK
                || b == Character.UnicodeBlock.GREEK_EXTENDED
                || b == Character.UnicodeBlock.DEVANAGARI
                || b == Character.UnicodeBlock.LATIN_1_SUPPLEMENT
                || b == Character.UnicodeBlock.LATIN_EXTENDED_A
                || b == Character.UnicodeBlock.LATIN_EXTENDED_B
                || b == Character.UnicodeBlock.LATIN_EXTENDED_ADDITIONAL
                || b == Character.UnicodeBlock.LATIN_EXTENDED_C
                || b == Character.UnicodeBlock.LATIN_EXTENDED_D) {
            return true;
        }
        return false;
    }

    /**
     * 模型约定无可译外文时输出 _NO_FOREIGN_（兼容旧提示 _NO_ENGLISH_）；过滤极短说明。
     */
    private static boolean isNoForeignOcrSupplement(String raw) {
        if (!StringUtils.hasText(raw)) {
            return true;
        }
        String t = raw.trim();
        if ("_NO_FOREIGN_".equalsIgnoreCase(t) || "_NO_ENGLISH_".equalsIgnoreCase(t)) {
            return true;
        }
        if (t.length() > 120) {
            return false;
        }
        String lower = t.toLowerCase(Locale.ROOT);
        return lower.contains("无外文")
                || lower.contains("没有外文")
                || lower.contains("无英文")
                || lower.contains("没有英文")
                || "none".equals(lower);
    }

    private Map<String, Object> invokePython(String task, Path filePath, String langOrMode) throws IOException, InterruptedException {
        Path script = resolveScriptPath();
        List<String> cmd = new ArrayList<>();
        cmd.add(pythonCmd);
        cmd.add(script.toString());
        cmd.add("--task");
        cmd.add(task);
        cmd.add("--input");
        cmd.add(filePath.toAbsolutePath().toString());
        if ("yolo".equals(task)) {
            cmd.add("--model");
            cmd.add(yoloModel);
            double c = yoloConfidence;
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
            if (StringUtils.hasText(yoloWorldExtraClasses)) {
                cmd.add("--yolo-world-extra-classes");
                cmd.add(yoloWorldExtraClasses.trim());
            }
        } else {
            cmd.add("--lang");
            cmd.add(langOrMode);
            String ob = ocrBackend == null ? "auto" : ocrBackend.trim();
            if (ob.isEmpty()) {
                ob = "auto";
            }
            cmd.add("--ocr-backend");
            cmd.add(ob);
        }

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        Map<String, String> env = pb.environment();
        env.put("PYTHONIOENCODING", "utf-8");
        env.put("YOLO_DOWNLOAD_TIMEOUT_S", String.valueOf(Math.max(60, yoloDownloadTimeoutSeconds)));
        env.put("ULTRALYTICS_ASSETS_TAG", yoloAssetsTag);
        env.put("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True");
        env.put("HF_ENDPOINT", "https://hf-mirror.com");
        env.put("FLAGS_use_mkldnn", "0");
        env.put("FLAGS_enable_pir_api", "0");
        env.put("KMP_DUPLICATE_LIB_OK", "TRUE");
        log.info("[vision][{}] start python: {}", task, String.join(" ", cmd));
        Process p = pb.start();

        long startedAt = System.currentTimeMillis();
        ExecutorService ioPool = Executors.newFixedThreadPool(2);
        Future<String> outFuture = ioPool.submit(() -> readAll(p.getInputStream()));
        Future<String> errFuture = ioPool.submit(() -> readAll(p.getErrorStream()));
        int timeout = Math.max(30, inferTimeoutSeconds);
        try {
            boolean finished = p.waitFor(timeout, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                throw new IllegalStateException(
                        "python inference timeout after " + timeout + "s. " +
                                "首次运行可能在下载模型，请先在终端执行一次模型预热命令。"
                );
            }
            String out = waitStream(outFuture);
            String err = waitStream(errFuture);
            log.info("[vision][{}] python finished: exit={}, outLen={}, errLen={}", task, p.exitValue(), out.length(), err.length());
            if (p.exitValue() != 0) {
                throw new IllegalStateException("python exit=" + p.exitValue() + ", err=" + err);
            }
            JSONObject json = new JSONObject(out);
            if (json.has("error")) {
                throw new IllegalStateException(json.optString("error"));
            }
            Map<String, Object> map = json.toMap();
            map.putIfAbsent("backend", "python");
            map.put("elapsedMs", System.currentTimeMillis() - startedAt);
            return map;
        } finally {
            ioPool.shutdownNow();
        }
    }

    private String waitStream(Future<String> future) throws IOException {
        try {
            return future.get(15, TimeUnit.SECONDS);
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

    /**
     * Ultralytics 只认常见图片后缀；此前用 .img 会导致 predict 报 “No images or videos found”。
     */
    private String inferImageSuffix(MultipartFile file) {
        String name = file.getOriginalFilename();
        if (StringUtils.hasText(name)) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String ext = name.substring(dot).toLowerCase(Locale.ROOT);
                switch (ext) {
                    case ".jpg":
                    case ".jpeg":
                    case ".png":
                    case ".webp":
                    case ".bmp":
                    case ".gif":
                    case ".tif":
                    case ".tiff":
                        return ext;
                    default:
                        break;
                }
            }
        }
        String ct = file.getContentType();
        if (StringUtils.hasText(ct)) {
            String c = ct.toLowerCase(Locale.ROOT);
            if (c.contains("png")) {
                return ".png";
            }
            if (c.contains("webp")) {
                return ".webp";
            }
            if (c.contains("jpeg") || c.endsWith("/jpg")) {
                return ".jpg";
            }
            if (c.contains("bmp")) {
                return ".bmp";
            }
            if (c.contains("gif")) {
                return ".gif";
            }
        }
        return ".jpg";
    }

    private Path saveToTemp(MultipartFile file, String ext) throws IOException {
        Path temp = Files.createTempFile("vision-", ext);
        file.transferTo(temp.toFile());
        return temp;
    }

    private String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    private void validateFile(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("文件不能为空");
        }
        if (file.getSize() > 20L * 1024 * 1024) {
            throw new IllegalArgumentException("文件过大，请控制在20MB内");
        }
    }

    private double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private Map<String, Object> heuristicYolo(int width, int height, MultipartFile file, String mode) {
        long hash = MultimodalHeuristicUtil.stableFileHash(file);
        int count = MultimodalHeuristicUtil.bounded(hash + width + height, 2, 5);

        String[] classes = {"person", "car", "bicycle", "bus", "motorcycle", "dog", "cat", "traffic_light"};
        List<Map<String, Object>> detections = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            long seed = hash + i * 131L + width * 17L + height * 13L;
            String label = classes[MultimodalHeuristicUtil.bounded(seed, 0, classes.length - 1)];
            double confidence = round2(MultimodalHeuristicUtil.boundedDouble(seed + 19, 0.62, 0.96));

            int x = MultimodalHeuristicUtil.bounded(seed + 7, 4, 72);
            int y = MultimodalHeuristicUtil.bounded(seed + 11, 5, 74);
            int w = MultimodalHeuristicUtil.bounded(seed + 23, 16, 36);
            int h = MultimodalHeuristicUtil.bounded(seed + 31, 16, 44);

            Map<String, Object> d = new LinkedHashMap<>();
            d.put("label", label);
            d.put("confidence", confidence);
            d.put("box", Arrays.asList(x, y, w, h));
            detections.add(d);
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("model", "YOLOv8-backend-fallback");
        resp.put("mode", StringUtils.hasText(mode) ? mode : "yolo");
        resp.put("width", width);
        resp.put("height", height);
        resp.put("detections", detections);
        resp.put("backend", "heuristic-fallback");
        return resp;
    }

    private Map<String, Object> heuristicOcr(MultipartFile file, String lang) {
        String fileName = Optional.ofNullable(file.getOriginalFilename()).orElse("unknown");
        long hash = MultimodalHeuristicUtil.stableFileHash(file);
        int lineCount = MultimodalHeuristicUtil.bounded(hash, 3, 6);

        List<String> lines = new ArrayList<>();
        lines.add("【OCR提取】文件：" + fileName);
        lines.add("解析语言：" + lang);
        for (int i = 0; i < lineCount; i++) {
            lines.add("示例文本行 " + (i + 1) + " - token:" + (hash % 10000 + i));
        }
        String text = String.join("\n", lines);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "OCR-backend-fallback");
        resp.put("lang", lang);
        resp.put("text", text);
        resp.put("lines", lines);
        resp.put("backend", "heuristic-fallback");
        return resp;
    }
}
