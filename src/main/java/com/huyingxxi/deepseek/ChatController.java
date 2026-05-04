package com.huyingxxi.deepseek; // 务必和你的项目包名一致

import com.huyingxxi.deepseek.demos.web.Result;
import okhttp3.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.slf4j.Logger; // 新增日志依赖
import org.slf4j.LoggerFactory; // 新增日志依赖
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@RestController
public class ChatController {
    // 👇 把限流代码加在这里（成员变量区）
    private final HashMap<String, Integer> requestCount = new HashMap<>();
    private final int MAX_LIMIT = 20; // 每人最多请求20次

    // ========== 1. 配置项 + 日志对象（核心：日志加在这里） ==========
    @Value("${deepseek.api.key}")
    private String apiKey;

    @Value("${deepseek.api.url}")
    private String apiUrl;

    @Value("${deepseek.api.model:deepseek-chat}")
    private String apiModel;

    /**
     * 注入到每次 API 调用的 system 角色，约束助手身份表述（不自称第三方模型名）。
     */
    @Value("${deepseek.chat.system-prompt}")
    private String chatSystemPrompt;

    // 👇 日志对象：加在类里，和apiKey/chatHistory同级 👇
    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);

    // 多轮对话全局变量
    private Map<String, JSONArray> chatHistory = new HashMap<>();

    // 带超时配置的 OkHttpClient（防止AI响应慢卡死项目）
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build();

    // ========== 2. 完整的chat方法（含日志+参数校验+历史长度限制） ==========
    @GetMapping("/chat")
    public Result<String> chat(
            @RequestParam String msg,
            @RequestParam(required = false) String userId
    ) throws IOException {
        // ========== 新增限流逻辑（直接粘贴，方法第一行）==========
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 步骤0：参数校验（新增，避免空消息）
        if (msg == null || msg.trim().isEmpty()) {
            logger.warn("用户{}发送了空消息", userId == null ? "default" : userId); // 空消息日志
            return Result.fail("请输入有效问题");
        }

        // 步骤1：处理用户ID

        // 步骤1.5：打印接收请求的日志（新增）
        logger.info("用户{}发送请求：{}", uid, msg);

        // 步骤2：初始化对话历史
        if (!chatHistory.containsKey(uid)) {
            chatHistory.put(uid, new JSONArray());
        }
        JSONArray history = chatHistory.get(uid);

        // 步骤3：添加用户消息到历史
        JSONObject userMsg = new JSONObject();
        userMsg.put("role", "user");
        userMsg.put("content", msg);
        history.put(userMsg);

        // 步骤4：构建请求体（prepend system，不写入本地 history，避免截断时丢失）
        JSONArray messagesForApi = new JSONArray();
        JSONObject systemMsg = new JSONObject();
        systemMsg.put("role", "system");
        systemMsg.put("content", chatSystemPrompt);
        messagesForApi.put(systemMsg);
        for (int i = 0; i < history.length(); i++) {
            messagesForApi.put(history.get(i));
        }

        JSONObject requestJson = new JSONObject();
        requestJson.put("model", apiModel);
        requestJson.put("messages", messagesForApi);
        String json = requestJson.toString();

        // 步骤5：调用DeepSeek API
        Request request = new Request.Builder()
                .url(apiUrl)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create(json, okhttp3.MediaType.parse("application/json")))
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                String errorMsg = "请求失败：" + response.code() + "，原因：" + response.message();
                logger.error("用户{}请求DeepSeek失败：{}", uid, errorMsg); // 接口失败日志
                return Result.fail(errorMsg);
            }

            // 步骤6：解析AI回答
            String jsonResponse = response.body().string();
            JSONObject obj = new JSONObject(jsonResponse);
            String answer = obj.getJSONArray("choices")
                    .getJSONObject(0)
                    .getJSONObject("message")
                    .getString("content");

            // 步骤6.5：打印AI回答的日志（新增）
            logger.info("用户{}的AI回答：{}", uid, answer);

            // 步骤7：添加AI回答到历史
            JSONObject aiMsg = new JSONObject();
            aiMsg.put("role", "assistant");
            aiMsg.put("content", answer);
            history.put(aiMsg);

            // 步骤8：限制历史长度（只保留最近10轮，20条消息）
            if (history.length() > 20) {
                history.remove(0);
                history.remove(0);
                logger.debug("用户{}的对话历史过长，已截断为最近10轮", uid); // 调试日志
            }
            chatHistory.put(uid, history);

            return Result.success(answer);
        } catch (Exception e) {
            // 步骤9：异常日志（新增，打印完整异常堆栈）
            logger.error("用户{}请求解析失败：", uid, e);
            return Result.fail("服务异常：" + e.getMessage());
        }
    }

    /**
     * 与 GET /chat 相同，供长文本（如音频转写全文）使用，避免 URL 过长被浏览器/网关截断。
     */
    @PostMapping(value = "/chat", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
    public Result<String> chatPost(
            @RequestParam String msg,
            @RequestParam(required = false) String userId
    ) throws IOException {
        return chat(msg, userId);
    }

    @GetMapping("/generateCode")
    public Result<String> generateCode(
            @RequestParam String language, // 编程语言：java/python/js等
            @RequestParam String requirement, // 代码需求
            @RequestParam(required = false) String userId
    ) throws IOException {

        // ========== 同样粘贴限流逻辑 ==========
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 构建精准提示词（让AI生成高质量代码）
        String prompt = String.format(
                "请用%s语言实现以下需求：%s。要求：1. 代码可直接运行；2. 加详细注释；3. 说明代码逻辑；4. 指出注意事项。",
                language, requirement
        );
        // 复用chat方法的逻辑（直接调用，不用重复写）
        return chat(prompt, userId);
    }

    @GetMapping("/processText")
    public Result<String> processText(
            @RequestParam String type, // 处理类型：summary（总结）/translate（翻译）/polish（润色）
            @RequestParam String content, // 要处理的文本
            @RequestParam(required = false) String userId
    ) throws IOException {

        // ========== 同样粘贴限流逻辑 ==========
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        String prompt = switch (type) {
            case "summary" -> "请总结以下文本，要求：简洁、核心信息不遗漏，字数控制在原文的1/3以内。文本：" + content;
            case "translate" -> "请把以下文本翻译成英文，要求：准确、通顺，符合英文表达习惯。文本：" + content;
            case "polish" -> "请润色以下文本，要求：语句通顺、逻辑清晰、语气自然，保留原意。文本：" + content;
            default -> "请处理以下文本：" + content;
        };
        return chat(prompt, userId);
    }

    @GetMapping("/clearHistory")
    public Result<String> clearHistory(@RequestParam(required = false) String userId) {
        // ========== 限流逻辑（正确写法）==========
        String uid = userId == null ? "default" : userId;
        // 1. 去掉 defaultValue:0，直接写 0
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            // 2. 去掉 msg:，直接传字符串
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 👇 删除这行重复的 uid 定义！！！
        // String uid = userId == null ? "default" : userId;

        // 清空历史逻辑（正确写法：去掉 data:）
        if (chatHistory.containsKey(uid)) {
            chatHistory.remove(uid);
            return Result.success("历史已清空");
        }
        return Result.success("无历史可清空");
    }

    @GetMapping("/study")
    public Result<String> study(
            @RequestParam String subject,
            @RequestParam(required = false) String userId
    ) throws IOException {
        // 限流逻辑（必加）
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 学习提示词（精准、大赛级）
        String prompt = "你是专业的学习助手，请针对以下内容，输出：1. 核心知识点；2. 重点考点；3. 高效学习建议。内容：" + subject;
        return chat(prompt, userId);
    }

    @GetMapping("/write")
    public Result<String> write(
            @RequestParam String topic,
            @RequestParam(required = false) String userId
    ) throws IOException {
        // 限流逻辑
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 创作提示词（规范、有输出要求）
        String prompt = "你是专业文案创作者，请围绕以下主题创作内容：1. 结构清晰（开头+正文+结尾）；2. 语言通顺；3. 符合正式场景。主题：" + topic;
        return chat(prompt, userId);
    }

    @GetMapping("/analyze")
    public Result<String> analyze(
            @RequestParam String question,
            @RequestParam(required = false) String userId
    ) throws IOException {
        // 限流逻辑
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 错题分析提示词（精准、实用）
        String prompt = "你是资深学科老师，请分析以下题目：1. 正确答案；2. 错误原因（假设用户答错）；3. 涉及知识点；4. 解题思路。题目：" + question;
        return chat(prompt, userId);
    }

    @GetMapping("/plan")
    public Result<String> plan(
            @RequestParam String goal,
            @RequestParam(required = false) String userId
    ) throws IOException {
        // 限流逻辑
        String uid = userId == null ? "default" : userId;
        requestCount.put(uid, requestCount.getOrDefault(uid, 0) + 1);
        if (requestCount.get(uid) > MAX_LIMIT) {
            return Result.fail("请求过于频繁，请稍后再试");
        }

        // 计划提示词（可执行、分阶段）
        String prompt = "你是专业规划师，请为以下目标生成详细计划：1. 分阶段（按时间/步骤）；2. 可执行；3. 标注关键节点。目标：" + goal;
        return chat(prompt, userId);
    }
}