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
import java.util.concurrent.TimeUnit;

/**
 * 将 OCR 得到的外语文本译为简体中文（DeepSeek Chat API）。
 */
@Service
public class DeepSeekTranslateService {

    private static final Logger log = LoggerFactory.getLogger(DeepSeekTranslateService.class);
    private static final int MAX_CHARS = 12000;

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();

    @Value("${deepseek.api.key}")
    private String apiKey;

    @Value("${deepseek.api.url}")
    private String apiUrl;

    @Value("${deepseek.api.model:deepseek-chat}")
    private String apiModel;

    @Value("${multimodal.vision.ocr-translate-enabled:true}")
    private boolean translateEnabled;

    /**
     * 外语文本 → 简体中文；失败时抛出异常由调用方记录日志。
     */
    public String translateToChinese(String sourceText) throws IOException {
        if (!translateEnabled) {
            throw new IllegalStateException("OCR translation disabled by configuration");
        }
        if (!StringUtils.hasText(sourceText)) {
            return "";
        }
        String trimmed = sourceText.trim();
        if (trimmed.length() > MAX_CHARS) {
            trimmed = trimmed.substring(0, MAX_CHARS);
            log.warn("[ocr-translate] text truncated to {} chars", MAX_CHARS);
        }

        JSONArray messages = new JSONArray();
        JSONObject system = new JSONObject();
        system.put("role", "system");
        system.put(
                "content",
                "你是翻译助手。用户将提供从图片 OCR 得到的文本。请仅输出简体中文译文，不要解释、不要前缀。"
                        + " 若原文已是中文可略作润色保持原意；保持换行与列表结构尽量一致。"
        );
        messages.put(system);
        JSONObject user = new JSONObject();
        user.put("role", "user");
        user.put("content", trimmed);
        messages.put(user);

        JSONObject requestJson = new JSONObject();
        requestJson.put("model", apiModel);
        requestJson.put("messages", messages);
        requestJson.put("temperature", 0.2);
        String json = requestJson.toString();

        Request request = new Request.Builder()
                .url(apiUrl)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IOException("translate HTTP " + response.code() + " " + response.message());
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

    /**
     * 中文为主的 OCR 中夹杂外文：将英文、日语、韩语及其它常见文字片段译为中文释义列表（与全文翻译 {@link #translateToChinese} 不同）。
     */
    public String translateForeignFragmentsInMixedOcr(String sourceText) throws IOException {
        if (!translateEnabled) {
            throw new IllegalStateException("OCR translation disabled by configuration");
        }
        if (!StringUtils.hasText(sourceText)) {
            return "";
        }
        String trimmed = sourceText.trim();
        if (trimmed.length() > MAX_CHARS) {
            trimmed = trimmed.substring(0, MAX_CHARS);
            log.warn("[ocr-translate-foreign] text truncated to {} chars", MAX_CHARS);
        }

        JSONArray messages = new JSONArray();
        JSONObject system = new JSONObject();
        system.put("role", "system");
        system.put(
                "content",
                "你是 OCR 后处理助手。用户提供的是从图片中识别出的文本，通常以简体中文为主，并可能夹杂多种外文。\n"
                        + "任务：找出需要向中文读者解释的外文片段，包括但不限于：\n"
                        + "• 英文及其它使用拉丁字母的语言（含带重音符号的法语、西班牙语等）\n"
                        + "• 日语（平假名、片假名、日文词语；与中文同形汉字若明显为日语专名也请说明）\n"
                        + "• 韩语（谚文 Hangul）\n"
                        + "• 俄语等使用西里尔字母的文字\n"
                        + "• 阿拉伯语、泰语、希伯来语、印地语（天城文）等其它非中文书写系统\n"
                        + "对每一小段外文给出准确、简洁的简体中文释义；机构名、品牌名可用通用中文译名或保留约定俗成写法。\n"
                        + "输出要求：\n"
                        + "1) 每条独占一行，格式为：外文原文 — 中文释义\n"
                        + "2) 不要翻译已是规范现代简体中文的内容；不要写前言、后记或与列表无关的说明。\n"
                        + "3) 若整段文本中没有任何需要释义的外文片段，仅输出一行：_NO_FOREIGN_\n"
                        + "4) 保持简洁，条目与外文片段数量大致对应。"
        );
        messages.put(system);
        JSONObject user = new JSONObject();
        user.put("role", "user");
        user.put("content", trimmed);
        messages.put(user);

        JSONObject requestJson = new JSONObject();
        requestJson.put("model", apiModel);
        requestJson.put("messages", messages);
        requestJson.put("temperature", 0.15);
        String json = requestJson.toString();

        Request request = new Request.Builder()
                .url(apiUrl)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IOException(
                        "translateForeignFragmentsInMixedOcr HTTP " + response.code() + " " + response.message());
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
}
