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
 * 视频「省时间」接口：结构化摘要+时间轴书签、文本检索、Video RAG 问答。
 * <p>
 * 纯视觉检索（如「穿红衣服的人」）当前以转写+YOLO 事件标签为主；像素级视觉 grounding 需后续 CLIP/多模态模型。
 */
@RestController
@RequestMapping("/api/video/insights")
public class VideoInsightController {

    private static final Logger log = LoggerFactory.getLogger(VideoInsightController.class);

    private final VideoPythonClient videoPythonClient;
    private final VideoInsightService videoInsightService;

    public VideoInsightController(VideoPythonClient videoPythonClient, VideoInsightService videoInsightService) {
        this.videoPythonClient = videoPythonClient;
        this.videoInsightService = videoInsightService;
    }

    /**
     * 生成约 200 字摘要 + 时间轴书签（依赖语音转写 + DeepSeek）。
     */
    @PostMapping(value = "/summary", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> summary(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "lang", required = false, defaultValue = "zh-CN") String lang
    ) throws Exception {
        validateFile(file);
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            Map<String, Object> asr;
            try {
                asr = videoPythonClient.run("asr", temp, lang);
            } catch (Exception e) {
                log.warn("[video-insights][summary] asr python failed", e);
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "语音转写失败，请确认 venv、ffmpeg、faster-whisper 可用: " + e.getMessage());
                return err;
            }
            List<Map<String, Object>> segments = videoInsightService.segmentsFromAsrMap(asr);
            String transcript = videoInsightService.buildTranscriptFromSegments(segments);
            if (!StringUtils.hasText(transcript)) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "无可用转写文本，请确认视频含语音且 faster-whisper/ffmpeg 正常");
                err.put("asrEngine", asr.get("engine"));
                return err;
            }
            Map<String, Object> llm = videoInsightService.summarizeWithBookmarks(transcript);
            Map<String, Object> out = new LinkedHashMap<>(llm);
            out.put("transcriptPreview", transcript.length() > 1200 ? transcript.substring(0, 1200) + "…" : transcript);
            out.put("asrEngine", asr.get("engine"));
            out.put("elapsedMsAsr", asr.get("elapsedMs"));
            return out;
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    /**
     * 在转写与（可选）YOLO 事件中检索查询词，定位到秒。
     */
    @PostMapping(value = "/search", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> search(
            @RequestParam("file") MultipartFile file,
            @RequestParam("q") String q,
            @RequestParam(value = "lang", required = false, defaultValue = "zh-CN") String lang,
            @RequestParam(value = "includeVisual", required = false, defaultValue = "false") boolean includeVisual
    ) throws Exception {
        validateFile(file);
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            Map<String, Object> asr = videoPythonClient.run("asr", temp, lang);
            List<Map<String, Object>> segments = videoInsightService.segmentsFromAsrMap(asr);
            List<Map<String, Object>> visual = null;
            if (includeVisual) {
                try {
                    Map<String, Object> det = videoPythonClient.run("detect", temp, lang);
                    Object ev = det.get("events");
                    if (ev instanceof List) {
                        visual = new ArrayList<>();
                        for (Object o : (List<?>) ev) {
                            if (o instanceof Map) {
                                visual.add((Map<String, Object>) o);
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[video-insights][search] detect skipped", e);
                }
            }
            List<Map<String, Object>> hits = videoInsightService.searchInTranscript(segments, q, visual);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("query", q);
            out.put("matches", hits);
            out.put(
                    "note",
                    "当前检索基于语音转写文本与（可选）YOLO 事件描述。"
                            + " 对纯画面细节（衣着颜色、摔倒动作等）的跨模态搜索需后续接入视觉-语言模型。"
            );
            out.put("asrEngine", asr.get("engine"));
            return out;
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    /**
     * 针对视频内容的问答（检索相关片段 + DeepSeek 生成答案）。
     */
    @PostMapping(value = "/ask", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> ask(
            @RequestParam("file") MultipartFile file,
            @RequestParam("question") String question,
            @RequestParam(value = "lang", required = false, defaultValue = "zh-CN") String lang
    ) throws Exception {
        validateFile(file);
        Path temp = saveToTemp(file, inferVideoSuffix(file));
        try {
            Map<String, Object> asr = videoPythonClient.run("asr", temp, lang);
            List<Map<String, Object>> segments = videoInsightService.segmentsFromAsrMap(asr);
            String transcript = videoInsightService.buildTranscriptFromSegments(segments);
            if (!StringUtils.hasText(transcript)) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "无可用转写，无法问答");
                err.put("asrEngine", asr.get("engine"));
                return err;
            }
            return videoInsightService.answerQuestion(transcript, question);
        } finally {
            Files.deleteIfExists(temp);
        }
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
        Path temp = Files.createTempFile("video-insights-", ext);
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
