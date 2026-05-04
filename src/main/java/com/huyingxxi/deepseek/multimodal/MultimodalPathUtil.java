package com.huyingxxi.deepseek.multimodal;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 解析 multimodal 脚本路径。Spring Boot 若从 {@code target} 目录启动，{@code user.dir} 会指向
 * {@code .../target}，导致 {@code scripts/xxx.py} 被错误解析为 {@code target/scripts/...}。
 */
public final class MultimodalPathUtil {

    private MultimodalPathUtil() {}

    /**
     * @param scriptPathConfig application.yml 中的相对路径（如 scripts/audio_transcribe.py）或绝对路径
     */
    public static Path resolveScriptPath(String scriptPathConfig) {
        Path raw = Paths.get(scriptPathConfig);
        if (raw.isAbsolute()) {
            return raw.normalize();
        }
        Path cwd = Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize();

        Path candidate = cwd.resolve(raw).normalize();
        if (Files.exists(candidate)) {
            return candidate;
        }

        if (cwd.getFileName() != null && "target".equalsIgnoreCase(cwd.getFileName().toString())) {
            Path parent = cwd.getParent();
            if (parent != null) {
                Path alt = parent.resolve(raw).normalize();
                if (Files.exists(alt)) {
                    return alt;
                }
            }
        }

        for (Path p = cwd; p != null; p = p.getParent()) {
            Path tryPath = p.resolve(raw).normalize();
            if (Files.exists(tryPath)) {
                return tryPath;
            }
        }

        return candidate;
    }
}
