package com.huyingxxi.deepseek.multimodal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.util.StringUtils;
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
 * 统一视频理解：画面（BLIP 抽样描述 + YOLO 事件）+ 语音（Whisper）+ 用户自定义需求 → DeepSeek 结构化输出。
 */
@RestController
@RequestMapping("/api/video")
public class VideoUnderstandingController {

    private static final Logger log = LoggerFactory.getLogger(VideoUnderstandingController.class);

    private final VideoPythonClient videoPythonClient;
    private final VisualCaptionPythonClient visualCaptionPythonClient;
    private final VideoInsightService videoInsightService;

    public VideoUnderstandingController(
            VideoPythonClient videoPythonClient,
            VisualCaptionPythonClient visualCaptionPythonClient,
            VideoInsightService videoInsightService) {
        this.videoPythonClient = videoPythonClient;
        this.visualCaptionPythonClient = visualCaptionPythonClient;
        this.videoInsightService = videoInsightService;
    }

    /**
     * multipart: file=视频；instruction=用户需求（可空，空则做整体总结）；lang=ASR 语言提示。
     */
    @PostMapping(value = "/understand", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> understand(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "instruction", required = false, defaultValue = "") String instruction,
            @RequestParam(value = "lang", required = false, defaultValue = "zh-CN") String lang
    ) throws Exception {
        validateFile(file);
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            Map<String, Object> bundle;
            try {
                bundle = videoPythonClient.run("bundle", temp, lang);
            } catch (Exception e) {
                log.warn("[video-understand] bundle failed", e);
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "视频分析子进程失败（抽帧/转写）。请确认 Python、ffmpeg、YOLO/Whisper 依赖: " + e.getMessage());
                return err;
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> detect = (Map<String, Object>) bundle.get("detect");
            @SuppressWarnings("unchecked")
            Map<String, Object> asr = (Map<String, Object>) bundle.get("asr");

            double duration = 0;
            if (detect != null && detect.get("duration") instanceof Number) {
                duration = ((Number) detect.get("duration")).doubleValue();
            }

            List<Map<String, Object>> events = extractEvents(detect);

            List<Map<String, Object>> captionFrames = Collections.emptyList();
            String captionNote = "";
            String captionEngine = "";
            if (visualCaptionPythonClient.isEnabled()) {
                try {
                    Map<String, Object> cap = visualCaptionPythonClient.run(temp);
                    captionEngine = Objects.toString(cap.get("engine"), "");
                    captionNote = Objects.toString(cap.get("note"), "");
                    Object fr = cap.get("frames");
                    if (fr instanceof List) {
                        captionFrames = new ArrayList<>();
                        for (Object o : (List<?>) fr) {
                            if (o instanceof Map) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> m = (Map<String, Object>) o;
                                captionFrames.add(m);
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[video-understand] visual caption failed", e);
                    captionNote = "画面语义描述未生成: " + e.getMessage();
                }
            } else {
                captionNote = "已关闭 multimodal.video.visual-caption-enabled（仅 YOLO + 语音）";
            }

            List<Map<String, Object>> segments =
                    asr != null ? videoInsightService.segmentsFromAsrMap(asr) : Collections.emptyList();
            String transcript = videoInsightService.buildTranscriptFromSegments(segments);

            Map<String, Object> llm =
                    videoInsightService.unifiedVideoUnderstand(
                            instruction, duration, events, captionFrames, transcript);

            Map<String, Object> out = new LinkedHashMap<>(llm);
            out.put("durationSec", round2(duration));
            out.put("visualCaptionEngine", captionEngine);
            out.put("visualCaptionNote", captionNote);
            if (detect != null) {
                out.put("detectEngine", detect.get("engine"));
            }
            if (asr != null) {
                out.put("asrEngine", asr.get("engine"));
            }
            out.put("instructionEcho", StringUtils.hasText(instruction) ? instruction.trim() : "");
            return out;
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private static List<Map<String, Object>> extractEvents(Map<String, Object> detect) {
        if (detect == null) {
            return Collections.emptyList();
        }
        Object evo = detect.get("events");
        if (!(evo instanceof List)) {
            return Collections.emptyList();
        }
        List<Map<String, Object>> events = new ArrayList<>();
        for (Object o : (List<?>) evo) {
            if (o instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) o;
                events.add(m);
            }
        }
        return events;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private void validateFile(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("视频文件不能为空");
        }
        if (file.getSize() > 300L * 1024 * 1024) {
            throw new IllegalArgumentException("视频文件过大，请控制在300MB以内");
        }
    }

    private Path saveToTemp(MultipartFile file, String ext) throws IOException {
        Path temp = Files.createTempFile("video-understand-", ext);
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
}
