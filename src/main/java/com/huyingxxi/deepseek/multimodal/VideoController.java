package com.huyingxxi.deepseek.multimodal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;

/**
 * 视频分析：默认调用 {@code scripts/video_analyze.py}（Ultralytics YOLO 抽帧 + 直方图场景变化；ASR 走 faster-whisper）。
 * 失败时可回退为占位数据（见 {@code multimodal.video.use-heuristic-fallback}）。
 */
@RestController
@RequestMapping("/api/video")
public class VideoController {

    private static final Logger log = LoggerFactory.getLogger(VideoController.class);

    private final VideoPythonClient videoPythonClient;

    @Value("${multimodal.video.use-heuristic-fallback:true}")
    private boolean useHeuristicFallback;

    public VideoController(VideoPythonClient videoPythonClient) {
        this.videoPythonClient = videoPythonClient;
    }

    /**
     * 轻量探活（不调用 Python）。用于前端在发起 multipart 分析前确认与 8081 的连通性。
     */
    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("service", "video-api");
        m.put("time", System.currentTimeMillis());
        return m;
    }

    /**
     * 诊断用：完整走 multipart + 落盘，但不调用 Python。
     * 若 {@code /health} 正常而本接口失败 → 上传/体积/杀毒软件等；若本接口正常而 {@code /detect} 失败 → 查 Python、YOLO、ffmpeg。
     */
    @PostMapping(value = "/echo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> echo(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        log.info("[video][echo] multipart name={} size={}", file.getOriginalFilename(), file.getSize());
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("ok", true);
            m.put("receivedBytes", file.getSize());
            m.put("name", file.getOriginalFilename());
            m.put("note", "echo only: no Python");
            return m;
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @PostMapping(value = "/detect", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> detect(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        log.info("[video][detect] multipart name={} size={}", file.getOriginalFilename(), file.getSize());
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            return invokePython("detect", temp, "zh-CN");
        } catch (Exception e) {
            log.warn("[video][detect] python failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("视频检测失败: " + e.getMessage(), e);
            }
            return heuristicDetect(file);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @PostMapping(value = "/keyframes", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> keyframes(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        log.info("[video][keyframes] multipart name={} size={}", file.getOriginalFilename(), file.getSize());
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            return invokePython("keyframes", temp, "zh-CN");
        } catch (Exception e) {
            log.warn("[video][keyframes] python failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("关键帧分析失败: " + e.getMessage(), e);
            }
            return heuristicKeyframes(file);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @PostMapping(value = "/asr", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> asr(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        log.info("[video][asr] multipart name={} size={}", file.getOriginalFilename(), file.getSize());
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            return invokePython("asr", temp, "zh-CN");
        } catch (Exception e) {
            log.warn("[video][asr] python failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("视频语音分析失败: " + e.getMessage(), e);
            }
            return heuristicAsr(file);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    /**
     * 浏览器探活：说明 bundle 仅支持 POST，避免误用 GET 看到「系统异常：GET not supported」。
     */
    @GetMapping("/bundle")
    public Map<String, Object> bundleGetHelp() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("usage", "POST multipart/form-data，字段名 file；请在 video.html 上传视频，勿在地址栏直接打开本 URL。");
        m.put("postPath", "/api/video/bundle");
        return m;
    }

    /**
     * 一次上传完成画面检测、关键帧列表与语音转写；避免浏览器对同一文件连发三次大请求引发 {@code ERR_CONNECTION_RESET}。
     */
    @PostMapping(value = "/bundle", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> bundle(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        log.info("[video][bundle] multipart name={} size={}", file.getOriginalFilename(), file.getSize());
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            return invokePython("bundle", temp, "zh-CN");
        } catch (Exception e) {
            log.warn("[video][bundle] python failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("视频综合分析失败: " + e.getMessage(), e);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("detect", heuristicDetect(file));
            out.put("keyframes", heuristicKeyframes(file));
            out.put("asr", heuristicAsr(file));
            return out;
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    @PostMapping(value = "/report", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> report(@RequestParam("file") MultipartFile file) throws IOException {
        validateFile(file);
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            return invokePython("report", temp, "zh-CN");
        } catch (Exception e) {
            log.warn("[video][report] python failed", e);
            if (!useHeuristicFallback) {
                throw new IllegalStateException("视频报告失败: " + e.getMessage(), e);
            }
            return heuristicReport(file);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private Map<String, Object> invokePython(String task, Path filePath, String lang) throws Exception {
        return videoPythonClient.run(task, filePath, lang);
    }

    private Path saveToTemp(MultipartFile file, String ext) throws IOException {
        Path temp = Files.createTempFile("video-", ext);
        try (InputStream in = file.getInputStream()) {
            Files.copy(in, temp, StandardCopyOption.REPLACE_EXISTING);
        }
        return temp;
    }

    private String inferVideoSuffix(MultipartFile file) {
        String name = file.getOriginalFilename();
        if (StringUtils.hasText(name)) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String ext = name.substring(dot).toLowerCase(Locale.ROOT);
                switch (ext) {
                    case ".mp4":
                    case ".mov":
                    case ".avi":
                    case ".webm":
                    case ".mkv":
                        return ext;
                    default:
                        break;
                }
            }
        }
        return ".mp4";
    }

    private void validateFile(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("视频文件不能为空");
        }
        if (file.getSize() > 300L * 1024 * 1024) {
            throw new IllegalArgumentException("视频文件过大，请控制在300MB以内");
        }
    }

    // ---------- 启发式占位（与旧版一致） ----------

    private Map<String, Object> heuristicDetect(MultipartFile file) {
        long hash = MultimodalHeuristicUtil.stableFileHash(file);
        double duration = Math.max(8, Math.min(120, Math.round(file.getSize() / 1024.0 / 40.0)));

        List<Map<String, Object>> events = new ArrayList<>();
        events.add(event("person", duration * 0.12, "人物出现", "画面左侧出现行人（占位）"));
        events.add(event("cut", duration * 0.31, "镜头切换", "切换到道路场景（占位）"));
        events.add(event("person", duration * 0.47, "车辆出现", "检测到车辆（占位）"));
        events.add(event("disappear", duration * 0.63, "物体消失", "车辆离开画面（占位）"));
        events.add(event("cut", duration * 0.81, "镜头切换", "切换到人群区域（占位）"));

        List<Map<String, Object>> detections = new ArrayList<>();
        detections.add(detection("person", 0.93, Arrays.asList(10, 22, 20, 42)));
        detections.add(detection("car", 0.87, Arrays.asList(51, 58, 24, 18)));
        detections.add(detection("bicycle", 0.76, Arrays.asList(74, 60, 17, 16)));

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "VideoDetect-heuristic");
        resp.put("token", hash % 100000);
        resp.put("duration", duration);
        resp.put("events", events);
        resp.put("detections", detections);
        return resp;
    }

    private Map<String, Object> heuristicKeyframes(MultipartFile file) {
        double duration = Math.max(8, Math.min(120, Math.round(file.getSize() / 1024.0 / 40.0)));
        List<Map<String, Object>> frames = new ArrayList<>();
        frames.add(frame(duration * 0.11, "第1关键帧（占位）"));
        frames.add(frame(duration * 0.38, "第2关键帧（占位）"));
        frames.add(frame(duration * 0.61, "第3关键帧（占位）"));
        frames.add(frame(duration * 0.84, "第4关键帧（占位）"));

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "Keyframe-heuristic");
        resp.put("frames", frames);
        return resp;
    }

    private Map<String, Object> heuristicAsr(MultipartFile file) {
        List<Map<String, Object>> subtitles = new ArrayList<>();
        subtitles.add(sub(1.2, 4.5, "旁白（占位）：场景开始。"));
        subtitles.add(sub(4.6, 7.5, "旁白（占位）：检测到运动目标。"));
        subtitles.add(sub(7.8, 10.2, "旁白（占位）：画面切换。"));

        List<Map<String, Object>> segments = new ArrayList<>();
        for (Map<String, Object> s : subtitles) {
            Map<String, Object> seg = new LinkedHashMap<>();
            seg.put("start", s.get("time"));
            seg.put("end", s.get("end"));
            seg.put("text", s.get("text"));
            segments.add(seg);
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "Video-ASR-heuristic");
        resp.put("subtitles", subtitles);
        resp.put("segments", segments);
        return resp;
    }

    private Map<String, Object> heuristicReport(MultipartFile file) {
        double duration = Math.max(8, Math.min(120, Math.round(file.getSize() / 1024.0 / 40.0)));
        String summary = "视频时长约 " + round2(duration) + " 秒（占位摘要）。请安装 Python 依赖并确认 video_analyze.py 可运行以启用真实 YOLO + 报告字段。";
        List<String> bullets = Arrays.asList(
                "当前为占位报告，指标与「适用场景」在真实推理后才会填满",
                "请检查 venv：ultralytics、opencv、faster-whisper；系统 PATH：ffmpeg",
                "可将 multimodal.video.use-heuristic-fallback 设为 false 以强制真实推理"
        );

        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("durationSec", round2(duration));
        metrics.put("fps", 0);
        metrics.put("sampleFrames", 0);
        metrics.put("sceneCuts", 0);
        metrics.put("newTargets", 0);
        metrics.put("disappears", 0);
        metrics.put("eventTotal", 0);
        metrics.put("topClasses", Collections.emptyList());

        List<Map<String, Object>> sections = new ArrayList<>();
        Map<String, Object> sec1 = new LinkedHashMap<>();
        sec1.put("title", "占位模式下");
        sec1.put("items", Arrays.asList(
                "事件与字幕为演示数据，不代表真实检测",
                "安装依赖并关闭占位后，可得到与本页「能力范围」一致的真实统计"
        ));
        sections.add(sec1);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("engine", "VideoReport-heuristic");
        resp.put("summary", summary);
        resp.put("bullets", bullets);
        resp.put("sections", sections);
        resp.put("metrics", metrics);
        resp.put("realWorldScenarios", Arrays.asList(
                "真实模式下：监控/停车场/剪辑打点等与 video_analyze 报告一致"
        ));
        resp.put("reportVersion", "structured-v1");
        return resp;
    }

    private Map<String, Object> event(String type, double time, String title, String desc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("time", round2(time));
        m.put("title", title);
        m.put("desc", desc);
        return m;
    }

    private Map<String, Object> detection(String label, double confidence, List<Integer> box) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("label", label);
        m.put("confidence", confidence);
        m.put("box", box);
        return m;
    }

    private Map<String, Object> frame(double time, String caption) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("time", round2(time));
        m.put("caption", caption);
        return m;
    }

    private Map<String, Object> sub(double start, double end, String text) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("time", round2(start));
        m.put("end", round2(end));
        m.put("text", text);
        return m;
    }

    private double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
