package com.huyingxxi.deepseek.multimodal;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 视频「省时间」能力：基于语音转写 + DeepSeek 的结构化摘要/书签、文本检索与 Video RAG 问答。
 * 纯视觉描述（如「穿红衣服的女人」）需后续接入 CLIP/视频多模态模型；当前检索以转写文本 + YOLO 事件标签为主。
 */
@Service
public class VideoInsightService {

    private static final Logger log = LoggerFactory.getLogger(VideoInsightService.class);
    private static final int MAX_TRANSCRIPT_CHARS = 28000;
    private static final Pattern JSON_BLOCK = Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```", Pattern.CASE_INSENSITIVE);

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build();

    @Value("${deepseek.api.key}")
    private String apiKey;

    @Value("${deepseek.api.url}")
    private String apiUrl;

    @Value("${deepseek.api.model:deepseek-chat}")
    private String apiModel;

    /**
     * 生成约 200 字摘要 + 时间轴书签（JSON）。
     */
    public Map<String, Object> summarizeWithBookmarks(String transcriptForLlm) throws IOException {
        String sys =
                "你是会议与课程纪要助手。用户将提供带时间戳的语音转写。请严格只输出一个 JSON 对象，不要 Markdown，不要解释。"
                        + " JSON 结构：{\"summary\":\"约200字以内的中文要点总结\","
                        + "\"bookmarks\":[{\"timeSec\":数字秒,\"title\":\"短标题\",\"detail\":\"一句说明\"}]}"
                        + " bookmarks 5～12 条，按时间升序；timeSec 必须来自转写中可对应的时间点。";
        String raw = completeChat(sys, transcriptForLlm);
        JSONObject json = extractJsonObject(raw);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("summary", json.optString("summary", "").trim());
        out.put("bookmarks", json.optJSONArray("bookmarks") != null ? json.getJSONArray("bookmarks").toList() : Collections.emptyList());
        return out;
    }

    /**
     * 在转写片段中检索查询词，返回命中的时间段（秒级）。
     */
    public List<Map<String, Object>> searchInTranscript(
            List<Map<String, Object>> segments,
            String query,
            List<Map<String, Object>> optionalVisualEvents
    ) {
        if (!StringUtils.hasText(query) || segments == null || segments.isEmpty()) {
            return Collections.emptyList();
        }
        String q = query.trim().toLowerCase(Locale.ROOT);
        List<String> tokens = tokenizeForSearch(q);
        boolean queryMostlyAsciiLetters =
                q.chars().allMatch(ch -> !Character.isLetter(ch) || ch < 128);

        List<Scored> scored = new ArrayList<>();
        for (Map<String, Object> seg : segments) {
            String text = Objects.toString(seg.get("text"), "");
            double start = toDouble(seg.get("start"), toDouble(seg.get("time"), 0));
            double end = toDouble(seg.get("end"), start + 1.2);
            String hay = text.toLowerCase(Locale.ROOT);
            int score = 0;
            if (hay.contains(q)) {
                score += 10_000;
            }
            for (String t : tokens) {
                if (t.length() >= 2 && hay.contains(t)) {
                    score += 5;
                }
            }
            if (queryMostlyAsciiLetters) {
                for (char c : q.toCharArray()) {
                    if (Character.isLetterOrDigit(c) && hay.indexOf(c) >= 0) {
                        score += 1;
                    }
                }
            }
            if (score > 0) {
                scored.add(new Scored(start, end, text, score));
            }
        }

        if (optionalVisualEvents != null) {
            for (Map<String, Object> ev : optionalVisualEvents) {
                String title = Objects.toString(ev.get("title"), "");
                String desc = Objects.toString(ev.get("desc"), "");
                double t = toDouble(ev.get("time"), 0);
                String blob = (title + " " + desc).toLowerCase(Locale.ROOT);
                int score = 0;
                if (blob.contains(q)) {
                    score += 40;
                }
                for (String tok : tokens) {
                    if (tok.length() >= 2 && blob.contains(tok)) {
                        score += 8;
                    }
                }
                if (queryMostlyAsciiLetters) {
                    for (char c : q.toCharArray()) {
                        if (Character.isLetterOrDigit(c) && blob.indexOf(c) >= 0) {
                            score += 1;
                        }
                    }
                }
                if (score > 0) {
                    scored.add(new Scored(t, t, "[" + title + "] " + desc, score));
                }
            }
        }

        scored.sort(
                (a, b) -> {
                    int cmp = Integer.compare(b.score, a.score);
                    if (cmp != 0) {
                        return cmp;
                    }
                    return Double.compare(b.start, a.start);
                });
        List<Map<String, Object>> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Scored s : scored) {
            String key = String.format(Locale.ROOT, "%.2f:%s", s.start, s.text.hashCode());
            if (seen.add(key)) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("timeSec", round2(s.start));
                m.put("endSec", round2(s.end));
                m.put("snippet", s.text.length() > 280 ? s.text.substring(0, 280) + "…" : s.text);
                m.put("score", s.score);
                out.add(m);
                if (out.size() >= 15) {
                    break;
                }
            }
        }
        return out;
    }

    /**
     * Video RAG：用检索到的片段作为上下文回答。
     */
    /**
     * 综合画面抽样描述（BLIP 英文）、YOLO 级事件、语音转写与「用户需求」，由 DeepSeek 生成中文结构化结果。
     */
    public Map<String, Object> unifiedVideoUnderstand(
            String userInstruction,
            double durationSec,
            List<Map<String, Object>> yoloEvents,
            List<Map<String, Object>> visualCaptionFrames,
            String transcriptBlock
    ) throws IOException {
        String instr =
                StringUtils.hasText(userInstruction)
                        ? userInstruction.trim()
                        : "（用户未填写额外需求，请给出视频整体总结即可）";

        StringBuilder yolo = new StringBuilder();
        if (yoloEvents != null) {
            for (Map<String, Object> e : yoloEvents) {
                yolo.append("[t=")
                        .append(e.get("time"))
                        .append("s] ")
                        .append(Objects.toString(e.get("title"), ""))
                        .append(" — ")
                        .append(Objects.toString(e.get("desc"), ""))
                        .append("\n");
            }
        }

        StringBuilder cap = new StringBuilder();
        if (visualCaptionFrames != null) {
            for (Map<String, Object> f : visualCaptionFrames) {
                cap.append("[t=")
                        .append(f.get("time"))
                        .append("s] ")
                        .append(Objects.toString(f.get("caption_en"), ""))
                        .append("\n");
            }
        }

        String trans =
                StringUtils.hasText(transcriptBlock)
                        ? transcriptBlock
                        : "（无可用语音转写：可能为静音、仅背景音乐、或 ASR 未就绪）";

        String sys =
                "你是视频理解助手。输入包含：视频时长、用户需求、画面抽样英文描述（图像描述模型 BLIP，可能为空）、"
                        + "YOLO 通用目标检测级事件（仅人/车等类别，不能单独证明「在吃饭」等细粒度行为）、以及带时间戳的语音转写。\n"
                        + "若英文画面描述中出现 eating、sitting、cooking 等词，可审慎写入 visualSummary；若仅有 YOLO 的 person，不要编造吃饭等细节。\n"
                        + "你必须只输出**一个** JSON 对象，不要使用 Markdown 代码围栏，不要任何解释性前言。\n"
                        + "JSON 字段：{\"summary\":\"整体中文总结（画面+声音综合）\","
                        + "\"visualSummary\":\"侧重可见场景与行为\","
                        + "\"audioSummary\":\"侧重语音要点；无语音则说明\","
                        + "\"directAnswer\":\"直接针对用户需求的回答；需求仅为总结时可与 summary 一致\","
                        + "\"highlights\":[{\"timeSec\":数字,\"text\":\"要点\"}]}\n"
                        + "highlights 最多 8 条，timeSec 尽量对应材料中的时间。";

        String user =
                "视频时长约 "
                        + round2(durationSec)
                        + " 秒。\n\n【用户需求】\n"
                        + instr
                        + "\n\n【画面抽样英文描述（可能为空）】\n"
                        + (cap.length() > 0 ? cap : "（空）")
                        + "\n\n【粗粒度画面事件（YOLO）】\n"
                        + (yolo.length() > 0 ? yolo : "（空）")
                        + "\n\n【语音转写】\n"
                        + trans;

        String raw = completeChat(sys, user);
        JSONObject json = extractJsonObject(raw);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("summary", json.optString("summary", "").trim());
        out.put("visualSummary", json.optString("visualSummary", "").trim());
        out.put("audioSummary", json.optString("audioSummary", "").trim());
        out.put("directAnswer", json.optString("directAnswer", "").trim());
        out.put(
                "highlights",
                json.optJSONArray("highlights") != null ? json.getJSONArray("highlights").toList() : Collections.emptyList());
        return out;
    }

    public Map<String, Object> answerQuestion(String transcriptForLlm, String question) throws IOException {
        if (!StringUtils.hasText(question)) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("answer", "问题不能为空");
            m.put("citations", Collections.emptyList());
            return m;
        }
        List<Map<String, Object>> segments = parseSegmentsFromTranscriptBlock(transcriptForLlm);
        List<Map<String, Object>> ranked = searchInTranscript(segments, question, null);
        StringBuilder ctx = new StringBuilder();
        List<Map<String, Object>> citations = new ArrayList<>();
        int n = 0;
        for (Map<String, Object> hit : ranked) {
            double ts = toDouble(hit.get("timeSec"), 0);
            String snip = Objects.toString(hit.get("snippet"), "");
            ctx.append("[").append(formatHms(ts)).append("] ").append(snip).append("\n");
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("timeSec", hit.get("timeSec"));
            c.put("snippet", snip);
            citations.add(c);
            if (++n >= 8) {
                break;
            }
        }
        if (ctx.length() < 20 && StringUtils.hasText(transcriptForLlm)) {
            int lim = Math.min(transcriptForLlm.length(), 12000);
            ctx.append(transcriptForLlm, 0, lim);
        }
        String sys =
                "你是助手。下面「仅」根据用户提供的视频语音转写摘录回答问题。"
                        + " 若转写中没有依据，请明确说「转写中未提及」，不要臆测。"
                        + " 回答使用简体中文，简洁有条理；可引用时间戳。";
        String user = "问题：" + question.trim() + "\n\n相关转写摘录：\n" + ctx;
        String answer = completeChat(sys, user);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("answer", answer.trim());
        m.put("citations", citations);
        return m;
    }

    /** 将 segments 列表转为带 [HH:MM:SS] 的大段文本，供 LLM 使用 */
    public String buildTranscriptFromSegments(List<Map<String, Object>> segments) {
        if (segments == null || segments.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (Map<String, Object> seg : segments) {
            double start = toDouble(seg.get("start"), toDouble(seg.get("time"), 0));
            String text = Objects.toString(seg.get("text"), "").trim();
            if (!StringUtils.hasText(text)) {
                continue;
            }
            sb.append("[").append(formatHms(start)).append("] ").append(text).append("\n");
            if (sb.length() >= MAX_TRANSCRIPT_CHARS) {
                sb.append("\n…（后文过长已截断）");
                break;
            }
        }
        return sb.toString().trim();
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> segmentsFromAsrMap(Map<String, Object> asr) {
        Object raw = asr.get("segments");
        if (raw instanceof List) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object o : (List<?>) raw) {
                if (o instanceof Map) {
                    out.add((Map<String, Object>) o);
                }
            }
            return out;
        }
        List<Map<String, Object>> out = new ArrayList<>();
        Object subs = asr.get("subtitles");
        if (subs instanceof List) {
            for (Object o : (List<?>) subs) {
                if (o instanceof Map) {
                    Map<String, Object> m = new LinkedHashMap<>((Map<String, Object>) o);
                    if (!m.containsKey("start")) {
                        m.put("start", m.get("time"));
                    }
                    if (!m.containsKey("end")) {
                        m.put("end", toDouble(m.get("time"), 0) + 2);
                    }
                    out.add(m);
                }
            }
        }
        return out;
    }

    private List<Map<String, Object>> parseSegmentsFromTranscriptBlock(String block) {
        List<Map<String, Object>> segs = new ArrayList<>();
        if (!StringUtils.hasText(block)) {
            return segs;
        }
        String[] lines = block.split("\n");
        Pattern lineP = Pattern.compile("^\\[(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)\\]\\s*(.*)$");
        for (String line : lines) {
            Matcher m = lineP.matcher(line.trim());
            if (m.matches()) {
                int hh = Integer.parseInt(m.group(1));
                int mm = Integer.parseInt(m.group(2));
                double ss = Double.parseDouble(m.group(3));
                double t = hh * 3600 + mm * 60 + ss;
                Map<String, Object> seg = new LinkedHashMap<>();
                seg.put("start", t);
                seg.put("end", t + 2);
                seg.put("text", m.group(4));
                segs.add(seg);
            }
        }
        return segs;
    }

    private String completeChat(String system, String user) throws IOException {
        JSONArray messages = new JSONArray();
        JSONObject sys = new JSONObject();
        sys.put("role", "system");
        sys.put("content", system);
        messages.put(sys);
        JSONObject u = new JSONObject();
        u.put("role", "user");
        u.put("content", user);
        messages.put(u);

        JSONObject requestJson = new JSONObject();
        requestJson.put("model", apiModel);
        requestJson.put("messages", messages);
        requestJson.put("temperature", 0.3);
        String json = requestJson.toString();

        Request request = new Request.Builder()
                .url(apiUrl)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IOException("DeepSeek HTTP " + response.code());
            }
            String body = response.body().string();
            JSONObject obj = new JSONObject(body);
            return obj.getJSONArray("choices")
                    .getJSONObject(0)
                    .getJSONObject("message")
                    .getString("content")
                    .trim();
        }
    }

    private JSONObject extractJsonObject(String raw) throws IOException {
        if (!StringUtils.hasText(raw)) {
            throw new IOException("模型返回为空");
        }
        String s = raw.trim();
        Matcher m = JSON_BLOCK.matcher(s);
        if (m.find()) {
            s = m.group(1).trim();
        }
        int a = s.indexOf('{');
        int b = s.lastIndexOf('}');
        if (a >= 0 && b > a) {
            s = s.substring(a, b + 1);
        }
        try {
            return new JSONObject(s);
        } catch (Exception e) {
            log.warn("[video-insight] JSON parse failed, raw head: {}", s.substring(0, Math.min(200, s.length())));
            throw new IOException("无法解析模型 JSON: " + e.getMessage(), e);
        }
    }

    private List<String> tokenizeForSearch(String q) {
        List<String> out = new ArrayList<>();
        String[] parts = q.split("\\s+");
        for (String p : parts) {
            if (p.length() >= 2) {
                out.add(p);
            }
        }
        if (q.length() >= 4) {
            for (int i = 0; i + 2 <= q.length(); i++) {
                out.add(q.substring(i, i + 2));
            }
        }
        return out;
    }

    private static String formatHms(double totalSec) {
        if (totalSec < 0) {
            totalSec = 0;
        }
        int h = (int) (totalSec / 3600);
        int m = (int) ((totalSec % 3600) / 60);
        double s = totalSec - h * 3600 - m * 60;
        if (h > 0) {
            return String.format(Locale.ROOT, "%02d:%02d:%05.2f", h, m, s);
        }
        return String.format(Locale.ROOT, "%02d:%05.2f", m, s);
    }

    private static double toDouble(Object o, double def) {
        if (o == null) {
            return def;
        }
        if (o instanceof Number) {
            return ((Number) o).doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(o));
        } catch (Exception e) {
            return def;
        }
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static final class Scored {
        final double start;
        final double end;
        final String text;
        final int score;

        Scored(double start, double end, String text, int score) {
            this.start = start;
            this.end = end;
            this.text = text;
            this.score = score;
        }
    }
}
